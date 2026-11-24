(function () {
  var baseurl = window.SITE.baseurl || "";
  var YEARS = window.SITE.years.map(String);
  var COL = OPData.COL, num = OPData.num, isReported = OPData.isReported;
  var id = new URLSearchParams(window.location.search).get("id") || "";

  // Rows of the yearly table: [label, CSV column, decimals] (decimals null = text).
  var FIELDS = [
    ["Residential units", "Multifamily Housing - Total Number of Residential Living Units", 0],
    ["Total GHG emissions (t CO2e)", COL.ghg, 1],
    ["Site EUI, weather normalized (kBtu/ft²)", COL.eui, 1],
    ["Difference from national median site EUI (%)", "% Difference from National Median Site EUI", 1],
    ["ENERGY STAR score", COL.score, 0],
    ["ENERGY STAR certified (years)", "ENERGY STAR Certification - Year(s) Certified", null],
    ["Electricity intensity, weather normalized (kWh/ft²)", "Electricity - Weather Normalized Site Electricity Intensity (Grid and Onsite Renewables) (kWh/ft²)", 1],
    ["Natural gas intensity, weather normalized (therms/ft²)", "Natural Gas - Weather Normalized Site Natural Gas Intensity (therms/ft²)", 2],
    ["Water use (kgal)", "Water Use (All Water Sources) (kgal)", 1],
    ["Water use intensity (gal/ft²)", "Water Use Intensity (All Water Sources) (gal/ft²)", 1],
    ["Water score (multifamily only)", "Water Score (Multifamily Only)", 0],
    ["Notes", "Property Notes", null]
  ];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fmt(n, digits) {
    return n.toLocaleString("en-US", { maximumFractionDigits: digits || 0 });
  }

  function formatPin(p) {
    return p.length === 10 ? p.slice(0, 2) + "-" + p.slice(2, 4) + "-" + p.slice(4, 7) + "-" + p.slice(7) : p;
  }

  // Most recent non-empty value of a column across years.
  function latest(rows, col) {
    for (var i = YEARS.length - 1; i >= 0; i--) {
      var v = rows[YEARS[i]] && (rows[YEARS[i]][col] || "").trim();
      if (v && v !== ".") return v;
    }
    return "";
  }

  function status(row) {
    if (row._unlisted) return { text: "Not on Village list", cls: "missing" };
    if (isReported(row)) return { text: "Reported", cls: "reported" };
    if (row._listed === false) return { text: "Missing from list", cls: "missing" };
    return { text: "Did not report", cls: "missing" };
  }

  function notFound() {
    document.getElementById("building-title").textContent = "Building not found";
    document.getElementById("building-subtitle").innerHTML =
      'No building with ID “' + esc(id) + '”. <a href="' + baseurl + '/?view=list">Browse all buildings</a>.';
    document.querySelector(".building-top").hidden = true;
    document.querySelector(".building-years").hidden = true;
  }

  function polygonsOf(geometry) {
    if (!geometry) return [];
    return geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
  }

  // Building footprint filled, inside a dashed outline of its parcel. Either may
  // be missing; with neither, there's no map.
  function renderMap(parcel, footprint) {
    var mapEl = document.getElementById("building-map");
    if (!parcel && !footprint) {
      mapEl.classList.add("no-map");
      mapEl.textContent = "No building or parcel shape available for this building.";
      return;
    }
    var coords = [];
    polygonsOf(parcel).concat(polygonsOf(footprint))
      .forEach(function (poly) { poly[0].forEach(function (p) { coords.push(p); }); });
    var bounds = coords.reduce(function (b, p) {
      return [[Math.min(b[0][0], p[0]), Math.min(b[0][1], p[1])], [Math.max(b[1][0], p[0]), Math.max(b[1][1], p[1])]];
    }, [[Infinity, Infinity], [-Infinity, -Infinity]]);

    var map = new maplibregl.Map({
      container: mapEl,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      bounds: bounds,
      fitBoundsOptions: { padding: 60, maxZoom: 18 }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", function () {
      if (parcel) {
        map.addSource("parcel", { type: "geojson", data: { type: "Feature", geometry: parcel, properties: {} } });
        map.addLayer({ id: "parcel-fill", type: "fill", source: "parcel",
          paint: { "fill-color": "#2a78d6", "fill-opacity": footprint ? 0.06 : 0.25 } });
        map.addLayer({ id: "parcel-line", type: "line", source: "parcel",
          paint: { "line-color": "#1c5cab", "line-width": footprint ? 1.5 : 2, "line-dasharray": footprint ? [2, 2] : [1, 0] } });
      }
      if (footprint) {
        map.addSource("footprint", { type: "geojson", data: { type: "Feature", geometry: footprint, properties: {} } });
        map.addLayer({ id: "footprint-fill", type: "fill", source: "footprint", paint: { "fill-color": "#7fb0ea", "fill-opacity": 1 } });
        map.addLayer({ id: "footprint-line", type: "line", source: "footprint", paint: { "line-color": "#0d366b", "line-width": 1.5 } });
      }
    });
  }

  // Area chart of one measure per year (GHG emissions, site EUI). Years without a
  // value break the area (and show "No data" at the baseline); a dotted line
  // bridges a gap between years that have values. The chart's section is hidden
  // when no year has a value.
  // opts: { col, sectionId, chartId, unit, digits }
  function niceStep(max) {
    var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function renderTrendChart(rows, opts) {
    var data = YEARS.map(function (y) { return { year: y, v: num(rows[y][opts.col]) }; });
    var values = data.filter(function (d) { return d.v !== null; }).map(function (d) { return d.v; });
    var section = document.getElementById(opts.sectionId);
    if (!values.length) { section.hidden = true; return; }
    section.hidden = false;

    var NS = "http://www.w3.org/2000/svg";
    function el(name, attrs, text) {
      var n = document.createElementNS(NS, name);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text !== undefined) n.textContent = text;
      return n;
    }

    var W = 560, H = 220, m = { top: 22, right: 8, bottom: 26, left: 48 };
    var pw = W - m.left - m.right, ph = H - m.top - m.bottom;
    var maxV = Math.max.apply(null, values);
    var step = maxV > 0 ? niceStep(maxV) : 1;
    var top = Math.max(step, Math.ceil(maxV / step) * step);
    var y = function (v) { return m.top + ph - (v / top) * ph; };
    var band = pw / data.length;
    var xAt = function (i) { return m.left + band * i + band / 2; };

    var chart = document.getElementById(opts.chartId);
    chart.innerHTML = "";
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, "aria-hidden": "true" });
    for (var t = 0; t <= top + 1e-9; t += step) {
      svg.appendChild(el("line", { x1: m.left, x2: W - m.right, y1: y(t), y2: y(t),
        stroke: t === 0 ? "#b5b4ae" : "var(--grid)", "stroke-width": 1 }));
      svg.appendChild(el("text", { x: m.left - 6, y: y(t) + 4, "text-anchor": "end", "font-size": 11,
        fill: "var(--text-muted)" }, fmt(t, step < 1 ? 1 : 0)));
    }

    var tip = document.createElement("div");
    tip.className = "tooltip";
    tip.hidden = true;

    // Area + line for each run of consecutive years with a value.
    var runs = [], run = [];
    data.forEach(function (d, i) {
      if (d.v !== null) run.push(i);
      else if (run.length) { runs.push(run); run = []; }
    });
    if (run.length) runs.push(run);
    // Dotted line across missing years in the middle (e.g. 2023 or 2024),
    // connecting the nearest years on either side that have a value.
    for (var k = 1; k < runs.length; k++) {
      var a = runs[k - 1][runs[k - 1].length - 1], b = runs[k][0];
      svg.appendChild(el("line", { x1: xAt(a), y1: y(data[a].v), x2: xAt(b), y2: y(data[b].v),
        stroke: "var(--reported)", "stroke-width": 2, "stroke-dasharray": "2 5", "stroke-linecap": "round" }));
    }
    runs.forEach(function (r) {
      if (r.length < 2) return;
      var line = r.map(function (i, k) { return (k ? "L" : "M") + xAt(i) + "," + y(data[i].v); }).join("");
      svg.appendChild(el("path", { d: line + "L" + xAt(r[r.length - 1]) + "," + y(0) + "L" + xAt(r[0]) + "," + y(0) + "Z",
        fill: "var(--reported)", "fill-opacity": 0.18, stroke: "none" }));
      svg.appendChild(el("path", { d: line, fill: "none", stroke: "var(--reported)", "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });

    var hover = el("line", { y1: m.top, y2: y(0), stroke: "var(--text-muted)", "stroke-width": 1,
      "stroke-dasharray": "3 3", visibility: "hidden" });
    svg.appendChild(hover);

    data.forEach(function (d, i) {
      var cx = xAt(i);
      var g = el("g", {});
      g.appendChild(el("rect", { x: m.left + band * i, y: m.top, width: band, height: ph, fill: "transparent" }));
      if (d.v !== null) {
        var yv = y(d.v);
        g.appendChild(el("circle", { cx: cx, cy: yv, r: 4.5, fill: "var(--reported)",
          stroke: "var(--surface)", "stroke-width": 2 }));
        g.appendChild(el("text", { x: cx, y: yv - 10, "text-anchor": "middle", "font-size": 11,
          fill: "var(--text-primary)" }, fmt(d.v, d.v < 10 ? 1 : opts.digits)));
      } else {
        g.appendChild(el("text", { x: cx, y: y(0) - 6, "text-anchor": "middle", "font-size": 11,
          fill: "var(--text-muted)" }, "No data"));
      }
      g.appendChild(el("text", { x: cx, y: H - 6, "text-anchor": "middle", "font-size": 12,
        fill: "var(--text-secondary)" }, d.year));
      g.addEventListener("mousemove", function (e) {
        hover.setAttribute("x1", cx); hover.setAttribute("x2", cx);
        hover.setAttribute("visibility", "visible");
        var box = chart.getBoundingClientRect();
        tip.innerHTML = "<strong>" + d.year + "</strong><br>" + (d.v !== null
          ? fmt(d.v, 1) + ' <span class="muted">' + opts.unit + "</span>"
          : '<span class="muted">No value reported</span>');
        tip.hidden = false;
        tip.style.left = Math.max(0, Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth)) + "px";
        tip.style.top = (e.clientY - box.top - tip.offsetHeight - 8) + "px";
      });
      g.addEventListener("mouseleave", function () { tip.hidden = true; hover.setAttribute("visibility", "hidden"); });
      svg.appendChild(g);
    });
    chart.appendChild(svg);
    chart.appendChild(tip);
  }

  function render(rows, parcelsByAddress, footprintsByKey) {
    var any = rows[YEARS[YEARS.length - 1]] || rows[YEARS[0]];
    var address = latest(rows, COL.address) || latest(rows, COL.address1);
    var name = latest(rows, COL.name);
    var title = name || address || "Building";
    document.title = title + " | " + document.title.split(" | ").slice(1).join(" | ");
    document.getElementById("building-title").textContent = title;
    document.getElementById("building-subtitle").textContent = name ? address : "";

    var reportedYears = YEARS.filter(function (y) { return isReported(rows[y]); });
    var statusEl = document.getElementById("building-status");
    if (any._unlisted) {
      statusEl.innerHTML = '<span class="badge missing">Not on the Village’s benchmarking list</span> ' +
        "The Cook County Assessor puts this building at " + fmt(any._assessor_sf) +
        " ft², over the 10,000 ft² threshold, but it doesn’t appear in any year’s benchmarking export.";
    } else {
      statusEl.innerHTML = '<span class="badge ' + (reportedYears.length ? "reported" : "missing") + '">Reported ' +
        reportedYears.length + " of " + YEARS.length + " years</span>";
    }

    // Parcel shape and PINs: unlisted buildings carry their own; listed ones are
    // matched by address (every address the building has had across years).
    var geometry = any._geometry || null, pins = any._pins ? any._pins.slice() : [];
    var footprint = any._unlisted ? (footprintsByKey[id] || null) : null;
    if (!any._unlisted) {
      var polys = [], seen = {}, fpPolys = [], fpSeen = {};
      YEARS.forEach(function (y) {
        var address = (rows[y][COL.address] || "").trim();
        var fp = footprintsByKey[address];
        polygonsOf(fp && fp.geometry).forEach(function (poly) {
          var k = JSON.stringify(poly[0][0]) + poly[0].length;
          if (!fpSeen[k]) { fpSeen[k] = true; fpPolys.push(poly); }
        });
        var p = parcelsByAddress[address];
        if (!p) return;
        var key = p.properties.pins.join(" ");
        if (seen[key]) return;
        seen[key] = true;
        p.properties.pins.forEach(function (pin) { if (pins.indexOf(pin) === -1) pins.push(pin); });
        polys = polys.concat(p.geometry.type === "MultiPolygon" ? p.geometry.coordinates : [p.geometry.coordinates]);
      });
      if (polys.length) geometry = { type: "MultiPolygon", coordinates: polys };
      if (fpPolys.length) footprint = { type: "MultiPolygon", coordinates: fpPolys };
    } else if (footprint) {
      footprint = footprint.geometry;
    }
    renderMap(geometry, footprint);

    var addresses = [];
    YEARS.forEach(function (y) {
      var a = (rows[y][COL.address] || "").trim();
      if (a && addresses.indexOf(a) === -1) addresses.push(a);
    });
    var selfSf = latest(rows, COL.gfa);
    var details = [
      ["Address", addresses.length ? addresses.join("<br>") : esc(any._addresses || address || "—"), true],
      ["Property type", latest(rows, COL.type) || (any._assessor_desc || "")],
      ["Owner", latest(rows, COL.owner)],
      ["Data administrator", latest(rows, "Property Data Administrator")],
      ["Floor area (self-reported)", selfSf ? fmt(num(selfSf)) + " ft²" : ""],
      ["Floor area (Cook County Assessor)", any._assessor_sf ? fmt(any._assessor_sf) + " ft²" : ""],
      ["Residential units", (function (u) { return u === null ? "" : fmt(u); })(num(latest(rows, "Multifamily Housing - Total Number of Residential Living Units")))],
      ["Parcel PINs", pins.map(formatPin).join(", ")],
      ["Years reported", reportedYears.length ? reportedYears.join(", ") : "None"],
      ["Oak Park Feature ID", any._unlisted ? "" : id]
    ];
    document.getElementById("building-details").innerHTML = details
      .filter(function (d) { return d[1]; })
      .map(function (d) { return "<dt>" + d[0] + "</dt><dd>" + (d[2] ? d[1] : esc(d[1])) + "</dd>"; })
      .join("");

    renderTrendChart(rows, { col: COL.ghg, sectionId: "ghg-section", chartId: "ghg-chart", unit: "t CO2e", digits: 0 });
    renderTrendChart(rows, { col: COL.eui, sectionId: "eui-section", chartId: "eui-chart", unit: "kBtu/ft²", digits: 1 });
    document.getElementById("trend-charts").hidden =
      document.getElementById("ghg-section").hidden && document.getElementById("eui-section").hidden;

    // Yearly table: one column per year, one row per field.
    var table = document.getElementById("years-table");
    table.querySelector("thead").innerHTML = "<tr><th></th>" +
      YEARS.map(function (y) { return '<th class="num">' + y + "</th>"; }).join("") + "</tr>";
    var statusRow = "<tr><th>Status</th>" + YEARS.map(function (y) {
      var s = status(rows[y]);
      return '<td class="num"><span class="badge ' + s.cls + '">' + s.text + "</span></td>";
    }).join("") + "</tr>";
    var fieldRows = FIELDS.filter(function (f) {
      return YEARS.some(function (y) { var v = (rows[y][f[1]] || "").trim(); return v && v !== "."; });
    }).map(function (f) {
      return "<tr><th>" + f[0] + "</th>" + YEARS.map(function (y) {
        var v = (rows[y][f[1]] || "").trim();
        if (!v || v === ".") return '<td class="num empty">—</td>';
        if (f[2] === null) return '<td class="text">' + esc(v) + "</td>";
        var n = num(v);
        return '<td class="num">' + (n === null ? esc(v) : fmt(n, f[2])) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    table.querySelector("tbody").innerHTML = statusRow + fieldRows;

    document.getElementById("years-note").textContent = any._unlisted
      ? "This building has no benchmarking data: it isn’t on the Village’s list in any year."
      : "“Missing from list” means the building wasn’t in that year’s benchmarking export. " +
        "A building counts as reported only when it has a GHG emissions value.";
  }

  var parcels = fetch(baseurl + "/data/parcels.geojson")
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .catch(function () { return { features: [] }; });

  var footprints = fetch(baseurl + "/data/footprints.geojson")
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .catch(function () { return { features: [] }; });

  Promise.all([OPData.loadYears(baseurl, YEARS), parcels, footprints]).then(function (res) {
    var byYear = res[0], rows = {};
    YEARS.forEach(function (y) {
      rows[y] = byYear[y].filter(function (r) { return r[COL.id] === id; })[0];
    });
    if (!id || YEARS.some(function (y) { return !rows[y]; })) return notFound();
    var parcelsByAddress = {};
    res[1].features.forEach(function (f) { parcelsByAddress[f.properties.address] = f; });
    var footprintsByKey = {};
    res[2].features.forEach(function (f) { footprintsByKey[f.properties.key] = f; });
    render(rows, parcelsByAddress, footprintsByKey);
  });
})();
