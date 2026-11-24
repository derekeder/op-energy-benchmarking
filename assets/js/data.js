// Shared data loading for the map and building list.
//
// Benchmarking covers every building of 10,000 ft² or more, so each year should
// list all covered buildings. The yearly exports don't always do that, so this
// builds a master list of covered buildings (every Feature ID in any year's
// export) and gives each year a row for every one of them. A building missing
// from a year's export gets a placeholder row (identity fields copied from its
// nearest listed year, everything else blank), which counts as not reported.
//
// Buildings the Cook County Assessor sizes at 10,000 ft² or more that aren't in
// any export (data/unlisted_buildings.geojson, from scripts/assessor_review.py)
// are added to every year as well; they never reported.
//
// Buildings whose self-reported floor area is under 10,000 ft² in every year
// they reported are treated as not covered and dropped from all years, except
// those in ALWAYS_COVERED.
window.OPData = (function () {
  var COL = {
    id: "Oak Park Feature ID",
    name: "Property Name",
    address: "CPL Property Address",
    address1: "Address Line 1",
    owner: "Owner",
    type: "Primary Property Type - Self Selected",
    gfa: "Property GFA - Self-Reported (ft²)",
    eui: "Weather Normalized Site EUI (kBtu/ft²)",
    score: "ENERGY STAR Score",
    ghg: "Total GHG Emissions (Metric Tons CO2e)"
  };
  var MIN_GFA = 10000;

  // Feature IDs kept as covered even though their self-reported floor area is
  // under MIN_GFA: Village-owned facilities, condo units reporting their share
  // of a larger building that is itself over 10,000 ft², and buildings the
  // Cook County Assessor sizes at 10,000 ft² or more (see scripts/assessor_review.py).
  // (North Pump Station's duplicate ID 2610785, listed only in 2023 with no
  // data, is deliberately left out; its main record 2621389 is covered.)
  var ALWAYS_COVERED = {
    // Village-owned facilities
    "2613100": "East Ave Fire Station, 900 S East Ave",
    "261756": "Augusta Fire Station, 212 Augusta St",
    "2621601": "Central Pump Station, 102 N Lombard Ave",
    "267538": "South Pump Station, 207 Garfield St",
    // Assessor building area >= 10,000 ft² (self-reported is lower)
    "2621608": "Avenue Square Condominium, 217 N Oak Park Ave (Assessor 69,404 ft²)",
    "261384698": "Turano Baking Co Office, 6500 Roosevelt Rd (Assessor 25,256 ft²)",
    "267225": "1000 Austin, 1000 S Austin Blvd (Assessor 21,942 ft²)",
    "264223": "Greenplan Properties VI, 1146 Ontario St (Assessor 15,840 ft²)",
    "2622176": "817 S Oak Park Ave (Assessor 14,800 ft²)",
    "2621890": "James Edward Place, 327 Harrison St (Assessor 11,706 ft²)",
    // Condo units in larger buildings
    "263421": "127 S Harvey Ave (127-33 South Harvey LLC)",
    "2613284": "319 Harrison St (Lucile Rose Gardens)",
    "2618233": "112 Home Ave (Kenton House)",
    "2618125": "1032 Washington Blvd",
    "2618313": "211 N Marion St (The Colonial House)",
    "2617733": "432 Clinton Ave (New Wave Real Estate)"
  };
  var IDENTITY = [COL.id, COL.name, COL.address, COL.address1, COL.owner];

  function num(v) {
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  // A building counts as reported only when it has a GHG emissions value.
  function isReported(row) {
    return num(row[COL.ghg]) !== null;
  }

  function parseCSV(url) {
    return new Promise(function (resolve) {
      Papa.parse(url, {
        download: true, header: true, skipEmptyLines: true,
        complete: function (r) { resolve(r.data); },
        error: function () { resolve([]); }
      });
    });
  }

  function buildYears(raw, years, unlisted) {
    var byId = {};   // id -> { year: row }
    var maxGfa = {}; // id -> largest self-reported floor area
    years.forEach(function (y) {
      raw[y].forEach(function (row) {
        var id = (row[COL.id] || "").trim();
        if (!id) return;
        row._listed = true;
        (byId[id] = byId[id] || {})[y] = row;
        var g = num(row[COL.gfa]);
        if (g !== null) maxGfa[id] = Math.max(maxGfa[id] || 0, g);
      });
    });

    var covered = Object.keys(byId).filter(function (id) {
      return !(id in maxGfa) || maxGfa[id] >= MIN_GFA || id in ALWAYS_COVERED;
    });

    var rowsByYear = {};
    years.forEach(function (y) {
      var extra = unlisted.map(function (f) {
        var row = { _listed: false, _unlisted: true, _geometry: f.geometry,
                    _assessor_sf: f.properties.assessor_sf, _assessor_desc: f.properties.description };
        IDENTITY.forEach(function (c) { row[c] = ""; });
        row[COL.id] = f.properties.id;
        row[COL.address] = f.properties.address;
        return row;
      });
      rowsByYear[y] = extra.concat(covered.map(function (id) {
        if (byId[id][y]) return byId[id][y];
        // Placeholder from the nearest listed year (ties go to the later year).
        var src = Object.keys(byId[id]).sort(function (a, b) {
          return Math.abs(a - y) - Math.abs(b - y) || b - a;
        })[0];
        var row = { _listed: false };
        IDENTITY.forEach(function (c) { row[c] = byId[id][src][c] || ""; });
        return row;
      }));
    });
    return rowsByYear;
  }

  var cache = null;

  // Resolves to { year: [rows] } with every covered building in every year.
  function loadYears(baseurl, years) {
    if (!cache) {
      var unlisted = fetch(baseurl + "/data/unlisted_buildings.geojson")
        .then(function (r) { return r.ok ? r.json() : { features: [] }; })
        .then(function (d) { return d.features || []; })
        .catch(function () { return []; });
      cache = Promise.all(years.map(function (y) {
        return parseCSV(baseurl + "/data/op-benchmarking-" + y + ".csv");
      }).concat([unlisted, parseCSV(baseurl + "/data/assessor_sizes.csv")])).then(function (lists) {
        var raw = {};
        years.forEach(function (y, i) { raw[y] = lists[i]; });
        var rowsByYear = buildYears(raw, years, lists[years.length]);
        // Assessor building area for listed buildings, by Feature ID.
        var sizes = {};
        lists[years.length + 1].forEach(function (r) {
          var sf = num(r.assessor_sf);
          if (sf !== null) sizes[r.feature_id] = sf;
        });
        years.forEach(function (y) {
          rowsByYear[y].forEach(function (row) {
            if (!row._assessor_sf && sizes[row[COL.id]]) row._assessor_sf = sizes[row[COL.id]];
          });
        });
        return rowsByYear;
      });
    }
    return cache;
  }

  // Year buttons (_includes/year-buttons.html) with a <select>-like interface:
  // .value (get/set) and addEventListener("change", fn). Arrow keys move
  // between years, as in a radio group.
  function yearPicker(id) {
    var root = document.getElementById(id);
    var buttons = Array.prototype.slice.call(root.querySelectorAll("button[data-year]"));
    var listeners = [];
    function current() {
      return buttons.filter(function (b) { return b.getAttribute("aria-checked") === "true"; })[0] || buttons[buttons.length - 1];
    }
    function set(year, fire) {
      var changed = current().dataset.year !== String(year);
      buttons.forEach(function (b) {
        var on = b.dataset.year === String(year);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      });
      if (fire && changed) listeners.forEach(function (fn) { fn(); });
    }
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { set(b.dataset.year, true); });
      b.addEventListener("keydown", function (e) {
        var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        var next = buttons[(i + step + buttons.length) % buttons.length];
        set(next.dataset.year, true);
        next.focus();
      });
    });
    return {
      get value() { return current().dataset.year; },
      set value(y) { set(y, false); },
      addEventListener: function (type, fn) { if (type === "change") listeners.push(fn); }
    };
  }

  return { yearPicker: yearPicker, COL: COL, MIN_GFA: MIN_GFA, num: num, isReported: isReported, parseCSV: parseCSV, loadYears: loadYears };
})();
