(function () {
  var scriptEl = document.currentScript;
  var tenantId = scriptEl.getAttribute("data-tenant");
  var whatsappNumber = scriptEl.getAttribute("data-whatsapp");

  if (!tenantId || !whatsappNumber) {
    console.error("[QBooker widget] Add data-tenant and data-whatsapp attributes to the script tag.");
    return;
  }

  var apiBase = new URL(scriptEl.src).origin;

  var container = document.getElementById("qbooker-widget-root");
  if (!container) {
    container = document.createElement("div");
    scriptEl.parentNode.insertBefore(container, scriptEl.nextSibling);
  }
  container.innerHTML = '<div style="font-family:sans-serif;font-size:14px;color:#5B6B79;">Loading locations…</div>';

  fetch(apiBase + "/api/public/tenant/" + tenantId + "/locations")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var locations = (data.locations || []).filter(function (l) { return l.code; });
      if (locations.length === 0) {
        container.innerHTML = "";
        return;
      }
      var html = '<div style="font-family:sans-serif;">';
      html += '<div style="font-size:14px;font-weight:600;color:#1B2733;margin-bottom:8px;">Find your nearest location</div>';
      locations.forEach(function (l) {
        var link = "https://wa.me/" + whatsappNumber.replace(/[^0-9]/g, "") + "?text=" + encodeURIComponent(l.code);
        html += '<a href="' + link + '" target="_blank" rel="noopener" ' +
          'style="display:block;text-decoration:none;border:1px solid #DCE4EA;border-radius:8px;' +
          'padding:10px 14px;margin-bottom:8px;color:#0F5FBF;font-size:14px;font-weight:500;">' +
          l.name + ' — Message us on WhatsApp →</a>';
      });
      html += "</div>";
      container.innerHTML = html;
    })
    .catch(function () {
      container.innerHTML = "";
    });
})();
