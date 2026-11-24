// Building list view on the map page: a sortable table of the same buildings the
// map shows (same year and sidebar filters), plus a text search.
//
// map.js calls OPList.render(year, allRows, shownRows, filtered) whenever the year
// or filters change. Rank is the GHG rank among every building that reported that
// year, so it stays the same while filters narrow the list.
window.OPList = (function () {
  var baseurl = window.SITE.baseurl || "";
  var COL = OPData.COL;
  var num = OPData.num;
  var isReported = OPData.isReported;

  var search = document.getElementById("search");
  var body = document.getElementById("buildings-body");
  var statusEl = document.getElementById("list-status");
  var headers = Array.prototype.slice.call(document.querySelectorAll(".buildings-table th[data-sort]"));

  // Sort state. Buildings that didn't report (and blank values) stay at the
  // bottom whichever way a column is sorted.
  var sortKey = "ghg", sortDir = "desc";
  var DEFAULT_DIR = { rank: "asc", building: "asc", type: "asc", gfa: "desc", ghg: "desc", eui: "desc", score: "desc" };
  var last = null;   // arguments of the latest render()
  var ranked = {};   // year -> true once _rank is set on that year's rows

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function fmt(n, digits) {
    if (n === null) return "&mdash;";
    return n.toLocaleString("en-US", { maximumFractionDigits: digits || 0 });
  }

  function buildingLabel(row) {
    return ((row[COL.name] || "").trim() || (row[COL.address] || row[COL.address1] || "").trim());
  }

  // GHG rank (1 = highest) among reporters in the year; non-reporters get none.
  function rank(year, rows) {
    if (ranked[year]) return;
    rows.filter(isReported)
      .sort(function (a, b) { return num(b[COL.ghg]) - num(a[COL.ghg]); })
      .forEach(function (row, i) { row._rank = i + 1; });
    rows.forEach(function (row) { if (!isReported(row)) row._rank = null; });
    ranked[year] = true;
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
        (a[COL.address] || "").localeCompare(b[COL.address] || "");
      if (va === null) return 1;
      if (vb === null) return -1;
      var c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return c * dir || (a._rank || Infinity) - (b._rank || Infinity);
    });
  }

  function updateHeaders() {
    headers.forEach(function (th) {
      if (th.dataset.sort === sortKey) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
  }

  function matchesSearch(row, q) {
    if (!q) return true;
    return [COL.name, COL.address, COL.owner, COL.address1].some(function (c) {
      return (row[c] || "").toLowerCase().indexOf(q) !== -1;
    });
  }

  function rowHTML(r) {
    var rep = isReported(r);
    var name = (r[COL.name] || "").trim();
    var address = (r[COL.address] || r[COL.address1] || "").trim();
    var href = OPData.buildingUrl(baseurl, r[COL.id]);
    var building = name
      ? '<a href="' + href + '"><strong>' + esc(name) + '</strong></a><br><span class="muted">' + esc(address) + "</span>"
      : '<a href="' + href + '"><strong>' + esc(address || "Unknown address") + "</strong></a>";
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
  }

  function draw() {
    if (!last) return;
    var q = search.value.trim().toLowerCase();
    var shown = sortRows(last.shown.filter(function (r) { return matchesSearch(r, q); }));
    body.innerHTML = shown.map(rowHTML).join("");
    var narrowed = last.filtered || q;
    statusEl.textContent = (narrowed ? "Showing " + shown.length + " of " : "") + last.all.length +
      " covered buildings in " + last.year + "; " + last.all.filter(isReported).length + " reported.";
  }

  function render(year, all, shown, filtered) {
    rank(year, all);
    last = { year: year, all: all, shown: shown, filtered: filtered };
    draw();
  }

  search.addEventListener("input", draw);
  headers.forEach(function (th) {
    th.querySelector("button").addEventListener("click", function () {
      var key = th.dataset.sort;
      if (key === sortKey) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = DEFAULT_DIR[key]; }
      updateHeaders();
      draw();
    });
  });
  updateHeaders();

  return { render: render };
})();
