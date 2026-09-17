// Mobile nav: the links row scrolls sideways, so bring the current page's link into view.
(function () {
  function centre() {
    var row = document.querySelector('.nav-links');
    var active = row && row.querySelector('.nav-link.active');
    if (!row || !active || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', centre);
  else centre();
})();
