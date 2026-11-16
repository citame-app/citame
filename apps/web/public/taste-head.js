// Safe before hydration: the entrance always releases when JavaScript loads late.
if (location.pathname === "/") {
  document.documentElement.classList.add("m-enter");
  setTimeout(() => document.documentElement.classList.add("m-enter-done"), 700);
}
