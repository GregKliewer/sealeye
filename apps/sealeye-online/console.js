// console.js: what every seaLeye.online page shares. The top bar, the footer line, and
// the two or three helpers each page would otherwise write again.
const Console = (() => {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const NAV = [
    ["Environments", "index.html"],
    ["Catalog", "catalog.html"],
    ["Team", "team.html"]
  ];

  /** Fill the top bar and the footer. `current` is the section this page belongs to. */
  function chrome(state, current) {
    const org = document.getElementById("org");
    if (org) org.textContent = state.org;

    const disc = document.getElementById("userDisc");
    if (disc) disc.textContent = state.user.initial;

    const name = document.getElementById("userName");
    if (name) name.textContent = state.user.name;

    const nav = document.getElementById("nav");
    if (nav) {
      for (const [label, href] of NAV) {
        const link = el("a", null, label);
        // Some of these are real pages. The rest are here because a console has them.
        link.href = href || "#";
        if (label === current) link.setAttribute("aria-current", "page");
        if (!href) link.addEventListener("click", event => event.preventDefault());
        nav.appendChild(link);
      }
    }

    const footer = document.getElementById("footer");
    if (footer) footer.textContent = "State shown here is read from your environments, not from anyone's laptop.";
  }

  /** The value of one query parameter, or an empty string. */
  const query = name => new URLSearchParams(location.search).get(name) || "";

  /** "0.42", always two places, never scientific. */
  const money = n => (Math.round(n * 100) / 100).toFixed(2);

  /** A chip in one of the three tones the brand has. */
  function chip(text, tone) {
    return el("span", "chip " + (tone || "neutral"), text);
  }

  /** Breadcrumb: Environments / app / Page. Only the first link goes anywhere. */
  function crumbs(app, page) {
    const box = document.getElementById("crumbs");
    if (!box) return;

    const home = el("a", null, "Environments");
    home.href = "index.html";
    box.appendChild(home);
    box.appendChild(el("span", "sep", "/"));
    box.appendChild(el("span", "mono", app));
    box.appendChild(el("span", "sep", "/"));
    box.appendChild(el("span", null, page));
  }

  /** Hand the viewer a file. Used for the downloads, which really download. */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = el("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** A mock save: say it happened, then say nothing. */
  function flash(node, text) {
    node.hidden = false;
    node.textContent = text;
    clearTimeout(node._t);
    node._t = setTimeout(() => { node.hidden = true; }, 2400);
  }

  return { el, chrome, query, money, chip, crumbs, download, flash };
})();

// The strip of pages one environment has. Plan is the card on the list page; the
// rest are pages of their own. A torn down environment keeps only the two that
// outlive it: what it planned, and what it cost.
Console.subnav = function (app, current, opts) {
  const box = document.getElementById("subnav");
  if (!box) return;
  const { el } = Console;
  const o = opts || {};
  const live = o.live !== false;
  const query = "?app=" + encodeURIComponent(app) + (o.env ? "&env=" + encodeURIComponent(o.env) : "");
  const page = name => name + ".html" + query;

  const pages = [
    ["Plan", "index.html#" + encodeURIComponent(app), true],
    ["Configure", page("configure"), live],
    ["Costs", page("costs"), true],
    ["Logs", page("logs"), live],
    ["Performance", page("performance"), live],
    ["Control", page("control"), live]
  ];

  for (const [label, href, enabled] of pages) {
    const link = el("a", null, label);
    if (enabled) {
      link.href = href;
    } else {
      link.href = "#";
      link.setAttribute("aria-disabled", "true");
      link.title = "This environment was torn down. " + label + " went with it.";
      link.addEventListener("click", event => event.preventDefault());
    }
    if (label === current) link.setAttribute("aria-current", "page");
    box.appendChild(link);
  }
};
