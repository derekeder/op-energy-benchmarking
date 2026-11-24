(function () {
  var baseurl = window.SITE.baseurl || "";

  var COL = OPData.COL;
  var num = OPData.num;
  var isReported = OPData.isReported;

  var select = OPData.yearPicker("year-select");
  var search = document.getElementById("search");
  var body = document.getElementById("buildings-body");
  var statusEl = document.getElementById("list-status");
  var cache = {};

  // Sort state. Rank is always the GHG rank; buildings that didn't report (and
  // blank values) stay at the bottom whichever way a column is sorted.
  var sortKey = "ghg", sortDir = "desc";
  var DEFAULT_DIR = { rank: "asc", building: "asc", type: "asc", gfa: "desc", ghg: "desc", eui: "desc", score: "desc" };
  var headers = Array.prototype.slice.call(document.querySelectorAll("th[data-sort]"));

  function buildingLabel(row) {
    return ((row[COL.name] || "").trim() || (row[COL.address] || row["Address Line 1"] || "").trim());
  }

  function sortValue(row, key) {
    if (!isReported(row) && key !== "building") return null;
    switch (key) {
      case "rank": return row._rank;
      case "building": return buildingLabel(row).toLowerCase() || null;
      case "type": return (row[COL.type] || "").trim().toLowerCase() || null;
      default: return num(row[COL[key]]);
    }
  }

  function sortRows(rows) {
    var dir = sortDir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va = sortValue(a, sortKey), vb = sortValue(b, sortKey);
      if (va === null && vb === null) return (a._rank || Infinity) - (b._rank || Infinity) ||
        buildingLabel(a).localeCompare(buildingLabel(b));
      if (va === null) return 1;
      if (vb === null) return -1;
      var c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return c * dir || (a._rank || Infinity) - (b._rank || Infinity);
    });
  }

  function updateHeaders() {
    headers.forEach(function (th) {
      var active = th.dataset.sort === sortKey;
      if (active) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fmt(n, digits) {
    if (n === null) return "&mdash;";
    return n.toLocaleString("en-US", { maximumFractionDigits: digits || 0 });
  }

  function load(year) {
    if (cache[year]) return Promise.resolve(cache[year]);
    return OPData.loadYears(baseurl, window.SITE.years.map(String)).then(function (byYear) {
      // Reporters by GHG (high to low), then non-reporters by address.
      var rows = byYear[year].slice().sort(function (a, b) {
        var ga = num(a[COL.ghg]), gb = num(b[COL.ghg]);
        if (ga !== null && gb !== null) return gb - ga;
        if (ga !== null) return -1;
        if (gb !== null) return 1;
        return (a[COL.address] || "").localeCompare(b[COL.address] || "");
      });
      var rank = 0;
      rows.forEach(function (row) { row._rank = isReported(row) ? ++rank : null; });
      cache[year] = rows;
      return rows;
    });
  }

  function matches(row, q) {
    if (!q) return true;
    return [COL.name, COL.address, COL.owner, "Address Line 1"].some(function (c) {
      return (row[c] || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function render() {
    var year = select.value;
    load(year).then(function (rows) {
      if (year !== select.value) return; // a newer selection is loading
      var q = search.value.trim().toLowerCase();
      var shown = sortRows(rows.filter(function (r) { return matches(r, q); }));
      var reported = rows.filter(isReported).length;

      body.innerHTML = shown.map(function (r) {
        var rep = isReported(r);
        var name = (r[COL.name] || "").trim();
        var address = (r[COL.address] || r["Address Line 1"] || "").trim();
        var building = name
          ? "<strong>" + esc(name) + "</strong><br><span class=\"muted\">" + esc(address) + "</span>"
          : "<strong>" + esc(address || "Unknown address") + "</strong>";
        var cells = rep
          ? "<td>" + esc(r[COL.type] || "") + "</td>" +
            '<td class="num">' + fmt(num(r[COL.gfa])) + "</td>" +
            '<td class="num ghg">' + fmt(num(r[COL.ghg]), 1) + "</td>" +
            '<td class="num">' + fmt(num(r[COL.eui]), 1) + "</td>" +
            '<td class="num">' + fmt(num(r[COL.score])) + "</td>"
          : '<td colspan="5" class="not-reported">' +
            (r._unlisted
              ? "Not on the Village's list (Assessor: " + fmt(r._assessor_sf) + " ft²)"
              : "Did not report" + (r._listed === false ? " (missing from this year's list)" : "")) +
            "</td>";
        return '<tr class="' + (rep ? "" : "missing") + '">' +
          '<td class="num rank">' + (r._rank || "") + "</td>" +
          "<td>" + building + "</td>" + cells + "</tr>";
      }).join("");

      statusEl.textContent = (q ? "Showing " + shown.length + " of " : "") + rows.length +
        " covered buildings in " + year + "; " + reported + " reported.";
    });
  }

  // Keep the selected year in the URL (?year=2024) so links can point at a year.
  var params = new URLSearchParams(window.location.search);
  if (params.get("year") && window.SITE.years.map(String).indexOf(params.get("year")) !== -1) {
    select.value = params.get("year");
  }
  select.addEventListener("change", function () {
    params.set("year", select.value);
    history.replaceState(null, "", "?" + params.toString());
    render();
  });
  search.addEventListener("input", render);
  headers.forEach(function (th) {
    th.querySelector("button").addEventListener("click", function () {
      var key = th.dataset.sort;
      if (key === sortKey) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = DEFAULT_DIR[key]; }
      updateHeaders();
      render();
    });
  });
  updateHeaders();
  render();
})();
