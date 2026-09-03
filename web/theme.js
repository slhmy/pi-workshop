(() => {
  let preference = null;
  try {
    preference = window.localStorage.getItem("pi-color-theme");
  } catch {
    // Storage may be unavailable; the system preference remains the fallback.
  }

  const theme = preference === "light" || preference === "dark"
    ? preference
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
