/**
 * The dashboard UI, embedded as a string.
 *
 * It is deliberately one dependency-free page: no framework, no bundler, no build
 * step beyond `tsc`. That keeps `pnpm build` honest and means the dashboard cannot
 * rot separately from the server that serves it. The embedded script avoids
 * template literals so this file needs no escaping.
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DevMemory</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --border: #e2e5ea;
    --text: #1b1f24;
    --muted: #646d78;
    --accent: #2f6feb;
    --good: #1a7f47;
    --warn: #9a6700;
    --bad: #b42318;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216;
      --panel: #161b22;
      --border: #262d36;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #4f8bf0;
      --good: #3fb950;
      --warn: #d29922;
      --bad: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; gap: 16px; align-items: center; padding: 12px 20px;
    background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .3px; }
  header h1 span { color: var(--muted); font-weight: 400; }
  header .spacer { flex: 1; }
  select, button, input { font: inherit; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; flex-wrap: wrap;
    background: var(--panel); border-bottom: 1px solid var(--border); }
  nav button { border: none; background: none; border-bottom: 2px solid transparent;
    border-radius: 0; padding: 8px 12px; color: var(--muted); }
  nav button.active { color: var(--text); border-bottom-color: var(--accent); }
  main { padding: 20px; max-width: 1200px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .card h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase;
    letter-spacing: .6px; color: var(--muted); font-weight: 600; }
  .card .value { font-size: 26px; font-weight: 600; }
  .panel { background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px; margin-top: 16px; }
  .panel h2 { margin: 0 0 12px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  tr:last-child td { border-bottom: none; }
  td.mono, .mono { font-family: var(--mono); font-size: 12.5px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
    border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .badge.good { color: var(--good); border-color: var(--good); }
  .badge.warn { color: var(--warn); border-color: var(--warn); }
  .badge.bad { color: var(--bad); border-color: var(--bad); }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .bar { height: 6px; border-radius: 999px; background: var(--border); overflow: hidden; min-width: 90px; }
  .bar > div { height: 100%; background: var(--accent); }
  .empty { color: var(--muted); padding: 12px 0; }
  form.inline { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  form.inline input { flex: 1; min-width: 180px; }
  a.filelink { color: var(--accent); text-decoration: none; font-family: var(--mono); font-size: 12.5px; }
  a.filelink:hover { text-decoration: underline; }
  a.badge { text-decoration: none; }
  a.badge:hover { border-color: var(--accent); color: var(--accent); }
  .back { background: none; border: none; color: var(--muted); padding: 0 0 8px; }
  .back:hover { color: var(--accent); }
  .split { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .headline { background: var(--panel); border: 1px solid var(--accent); border-left-width: 4px;
    border-radius: 10px; padding: 14px 16px; margin-top: 16px; }
  .headline h3 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase;
    letter-spacing: .6px; color: var(--muted); font-weight: 600; }
  .headline .value { font-size: 16px; }
  ul.plain { margin: 0; padding-left: 18px; }
  ul.plain li { margin: 2px 0; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12.5px; }
</style>
</head>
<body>
<header>
  <h1>DevMemory <span id="home"></span></h1>
  <div class="spacer"></div>
  <select id="project"></select>
  <button id="reindex">Re-index</button>
  <button id="refresh" class="primary">Refresh</button>
</header>
<nav id="tabs"></nav>
<main id="view"><p class="empty">Loading…</p></main>

<script>
"use strict";
var TABS = ["Overview","Workspace","Handoff","Tasks","Issues","Memory","Code","Changes","Sessions","Search","Analytics","Security","Projects","Settings"];
var state = { tab: "Overview", projectId: null, projects: [], query: "", file: null, previousTab: "Overview",
  workspaces: [], workspace: null, wsQuery: "" };

function el(id) { return document.getElementById(id); }
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function api(path, options) {
  return fetch("/api" + path, options).then(function (response) {
    return response.json().then(function (body) {
      if (!response.ok) throw new Error((body.error && body.error.message) || response.statusText);
      return body;
    });
  });
}
function post(path, body, method) {
  return api(path, {
    method: method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
}
function render(html) { el("view").innerHTML = html; }
function card(title, value, note) {
  return '<div class="card"><h3>' + esc(title) + '</h3><div class="value">' + esc(value) + "</div>" +
    (note ? '<div class="muted">' + esc(note) + "</div>" : "") + "</div>";
}
function table(headers, rows) {
  if (!rows.length) return '<p class="empty">Nothing here yet.</p>';
  return "<table><thead><tr>" + headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") +
    "</tr></thead><tbody>" + rows.map(function (row) {
      return "<tr>" + row.map(function (cell) { return "<td>" + cell + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody></table>";
}
function statusBadge(status) {
  var kind = status === "IN_PROGRESS" ? "good" : status === "BLOCKED" ? "bad"
    : status === "COMPLETED" ? "good" : status === "TESTING" ? "warn" : "";
  return '<span class="badge ' + kind + '">' + esc(status) + "</span>";
}
function progressBar(progress) {
  var percent = progress ? progress.percent : 0;
  return '<div class="row"><div class="bar" style="flex:1"><div style="width:' + percent + '%"></div></div>' +
    '<span class="muted">' + (progress ? progress.done + "/" + progress.total : "0/0") + "</span></div>";
}
function shortDate(value) { return value ? String(value).slice(0, 19).replace("T", " ") : "-"; }

// Any file path rendered anywhere becomes a way into the file view.
function fileLink(path) {
  return '<a href="#" class="filelink" data-file="' + esc(path) + '">' + esc(path) + "</a>";
}

// In a workspace a path can belong to any member project, so the link carries the
// project with it - otherwise clicking a backend file while the picker says
// "mobile" opens the wrong file, or nothing at all.
function crossFileLink(projectName, path, line) {
  var project = findProjectByName(projectName);
  var label = esc(projectName) + " " + esc(path) + (line ? ":" + line : "");
  if (!project) return '<span class="mono">' + label + "</span>";
  return '<a href="#" class="filelink mono" data-file="' + esc(path) + '" data-project="' +
    esc(project.project_id) + '">' + label + "</a>";
}

function findProjectByName(name) {
  for (var i = 0; i < state.projects.length; i += 1) {
    if (state.projects[i].name === name) return state.projects[i];
  }
  return null;
}

// VS Code opens vscode://file/<absolute path>:<line>. The stored path is already
// forward-slashed, which is what the scheme expects on every platform.
function editorLink(absolute, line, label) {
  var target = "vscode://file/" + encodeURI(absolute).replace(/#/g, "%23") + (line ? ":" + line : "");
  return '<a class="badge" href="' + esc(target) + '" title="Open in VS Code">' + esc(label || "VS Code") + "</a>";
}

function openFile(path, projectId) {
  if (projectId && projectId !== state.projectId) {
    state.projectId = projectId;
    el("project").value = projectId;
  }
  if (state.tab !== "File") state.previousTab = state.tab;
  state.file = path;
  state.tab = "File";
  drawTabs();
  load();
}
function workspacePath(suffix) { return "/workspaces/" + encodeURIComponent(state.workspace) + (suffix || ""); }
function projectPath(suffix) { return "/projects/" + state.projectId + (suffix || ""); }

var views = {
  // The whole point of this view is what no single-project view can show: the
  // calls one repository makes into another, and the ones that land nowhere.
  Workspace: function () {
    if (!state.workspaces.length) {
      render('<p class="empty">No workspaces yet. Group the repositories of one product with ' +
        '<span class="mono">devmemory workspace create &lt;name&gt; --projects a,b,c</span>.</p>');
      return Promise.resolve();
    }

    return Promise.all([api(workspacePath()), api(workspacePath("/api"))]).then(function (results) {
      var status = results[0];
      var contracts = results[1];
      var picker = state.workspaces.length > 1
        ? '<div class="row"><label>Workspace</label><select id="wspick">' + state.workspaces.map(function (workspace) {
            return '<option value="' + esc(workspace.name) + '"' +
              (workspace.name === state.workspace ? " selected" : "") + ">" + esc(workspace.name) + "</option>";
          }).join("") + "</select></div>"
        : "";

      var broken = contracts.unmatchedCalls.map(function (link) {
        return [
          '<span class="badge bad">' + esc(link.method || "ANY") + "</span>",
          '<span class="mono">/' + esc(link.canonical) + "</span>",
          link.consumers.map(function (site) { return crossFileLink(site.project, site.path, site.line); }).join("<br>")
        ];
      });

      var linked = contracts.linked.slice(0, 60).map(function (link) {
        return [
          '<span class="badge">' + esc(link.method || "ANY") + "</span>",
          '<span class="mono">/' + esc(link.canonical) + "</span>",
          link.providers.map(function (site) { return crossFileLink(site.project, site.path, site.line); }).join("<br>"),
          link.consumers.map(function (site) { return crossFileLink(site.project, site.path, site.line); }).join("<br>")
        ];
      });

      render(picker +
        '<div class="grid">' +
        card("Projects", status.projects.length, esc(state.workspace)) +
        card("Files", status.totals.files) +
        card("Symbols", status.totals.symbols) +
        card("HTTP routes", contracts.totals.providers) +
        card("Calls linked", contracts.totals.linked, contracts.totals.consumers + " calls seen") +
        card("Calls with no route", contracts.totals.unmatched,
          contracts.totals.unmatched ? "needs a look" : "all calls reach a route") +
        "</div>" +

        '<div class="panel"><h2>Calls with no matching route</h2>' +
        (broken.length
          ? table(["Method", "Path", "Called by"], broken) +
            '<p class="muted">A route registered dynamically, or served by a project outside this ' +
            'workspace, can appear here without being a defect. Confirm before changing anything.</p>'
          : '<p class="empty">Every call reaches a route.</p>') +
        "</div>" +

        '<div class="panel"><h2>Projects</h2>' +
        table(["Project", "Role", "Files", "Symbols", "Memories", "Open tasks", "Branch"],
          status.projects.map(function (project) {
            return [esc(project.name), esc(project.role || "-"), esc(project.files), esc(project.symbols),
              esc(project.memories), esc(project.openTasks), esc(project.branch || "-")];
          })) + "</div>" +

        '<div class="panel"><h2>Search every project</h2>' +
        '<div class="row"><input id="wsq" placeholder="symbol, file or phrase" value="' + esc(state.wsQuery) + '">' +
        '<button id="wsgo">Search</button></div><div id="wsresults"></div></div>' +

        '<div class="panel"><h2>Routes that are called (' + contracts.totals.linked + ')</h2>' +
        table(["Method", "Path", "Served by", "Called by"], linked) +
        (contracts.externalCalls
          ? '<p class="muted">' + contracts.externalCalls + ' third-party calls ignored.</p>'
          : "") +
        "</div>");

      var pick = el("wspick");
      if (pick) {
        pick.addEventListener("change", function (event) {
          state.workspace = event.target.value;
          load();
        });
      }

      var run = function () {
        state.wsQuery = el("wsq").value.trim();
        if (!state.wsQuery) return;
        el("wsresults").innerHTML = '<p class="empty">Searching…</p>';
        api(workspacePath("/search?q=" + encodeURIComponent(state.wsQuery))).then(function (data) {
          el("wsresults").innerHTML = table(["Score", "Project", "Match"], data.results.map(function (result) {
            return [
              result.relevance.toFixed(2),
              '<span class="badge">' + esc(result.project) + "</span>",
              result.symbol
                ? esc(result.symbol.name) + ' <span class="muted">' + esc(result.symbol.type) + "</span><br>" +
                  crossFileLink(result.project, result.path, result.symbol.lines[0])
                : crossFileLink(result.project, result.path)
            ];
          }));
        });
      };
      el("wsgo").addEventListener("click", run);
      el("wsq").addEventListener("keydown", function (event) { if (event.key === "Enter") run(); });
      if (state.wsQuery) run();
    });
  },

  Overview: function () {
    return api("/overview").then(function (data) {
      render('<div class="grid">' +
        card("Projects", data.projects, data.active_projects + " active") +
        card("Open tasks", data.open_tasks) +
        card("Known issues", data.known_issues) +
        card("Memories", data.memories) +
        card("Indexed files", data.files) +
        card("Symbols", data.symbols) +
        card("Sessions", data.sessions) +
        "</div>" +
        '<div class="panel"><h2>Recently active projects</h2>' +
        table(["Project", "Framework", "Index", "Last seen"], data.recent.map(function (project) {
          return [esc(project.name), esc(project.framework || "-"),
            '<span class="badge">' + esc(project.index_status) + "</span>", esc(shortDate(project.last_seen_at))];
        })) + "</div>");
    });
  },

  Projects: function () {
    return api("/projects").then(function (data) {
      render('<div class="panel"><h2>Projects</h2>' +
        table(["Name", "Root", "Framework", "Languages", "Status"], data.projects.map(function (project) {
          return [esc(project.name), '<span class="mono">' + esc(project.root) + "</span>",
            esc(project.framework || "-"), esc((project.languages || []).join(", ") || "-"),
            '<span class="badge ' + (project.status === "active" ? "good" : "") + '">' + esc(project.status) + "</span>"];
        })) + "</div>");
    });
  },

  Tasks: function () {
    return api(projectPath("/tasks")).then(function (data) {
      var form = '<form class="inline" id="new-task">' +
        '<input name="title" placeholder="New task title" required />' +
        '<input name="requirements" placeholder="Requirements, comma separated" />' +
        '<button class="primary" type="submit">Create</button></form>';

      render('<div class="grid">' +
        card("Open", data.stats.open) + card("Blocked", data.stats.blocked) +
        card("Completed", data.stats.completed) + card("Total", data.stats.total) + "</div>" +
        '<div class="panel"><h2>Tasks</h2>' + form +
        table(["Key", "Title", "Status", "Progress", "Actions"], data.tasks.map(function (task) {
          return ['<span class="mono">' + esc(task.key) + "</span>", esc(task.title), statusBadge(task.status),
            progressBar(task.progress),
            '<button data-task="' + esc(task.key) + '" data-status="IN_PROGRESS">Start</button> ' +
            '<button data-task="' + esc(task.key) + '" data-status="COMPLETED">Done</button>'];
        })) + "</div>");

      el("new-task").addEventListener("submit", function (event) {
        event.preventDefault();
        var data = new FormData(event.target);
        var requirements = String(data.get("requirements") || "").split(",")
          .map(function (item) { return item.trim(); }).filter(Boolean);
        post(projectPath("/tasks"), { title: data.get("title"), requirements: requirements }).then(load);
      });
      Array.prototype.forEach.call(document.querySelectorAll("button[data-task]"), function (button) {
        button.addEventListener("click", function () {
          post(projectPath("/tasks/" + button.dataset.task), { status: button.dataset.status }, "PATCH")
            .then(load).catch(function (error) { alert(error.message); });
        });
      });
    });
  },

  Memory: function () {
    return api(projectPath("/memory")).then(function (data) {
      var form = '<form class="inline" id="new-memory">' +
        '<select name="type"><option>FACT</option><option>DECISION</option><option>CONSTRAINT</option>' +
        '<option>DISCOVERY</option><option>BUG</option><option>PATTERN</option><option>HISTORY</option></select>' +
        '<input name="title" placeholder="Title" required />' +
        '<input name="content" placeholder="What should be remembered?" required />' +
        '<button class="primary" type="submit">Remember</button></form>';

      render('<div class="panel"><h2>Project memory</h2>' + form +
        table(["Type", "Title", "Content", "Importance", ""], data.memories.map(function (memory) {
          return ['<span class="badge">' + esc(memory.type) + "</span>", esc(memory.title),
            '<span class="muted">' + esc(String(memory.content).slice(0, 160)) + "</span>",
            esc(memory.importance),
            '<button data-memory="' + esc(memory.id) + '">Archive</button>'];
        })) + "</div>");

      el("new-memory").addEventListener("submit", function (event) {
        event.preventDefault();
        var data = new FormData(event.target);
        post(projectPath("/memory"), {
          type: data.get("type"), title: data.get("title"), content: data.get("content")
        }).then(load).catch(function (error) { alert(error.message); });
      });
      Array.prototype.forEach.call(document.querySelectorAll("button[data-memory]"), function (button) {
        button.addEventListener("click", function () {
          api(projectPath("/memory/" + button.dataset.memory), { method: "DELETE" }).then(load);
        });
      });
    });
  },

  Changes: function () {
    return api(projectPath("/changes")).then(function (data) {
      var git = data.git
        ? '<div class="grid">' + card("Branch", data.git.branch || "detached") +
          card("Worktree", data.git.clean ? "clean" : data.git.changedFiles + " changed") +
          card("Ahead", data.git.ahead) + card("Behind", data.git.behind) + "</div>"
        : '<p class="empty">This project is not a git repository.</p>';

      render(git +
        '<div class="panel"><h2>Working tree</h2>' +
        table(["File", "State"], data.status.map(function (file) {
          return [fileLink(file.path),
            '<span class="badge">' + esc(file.untracked ? "untracked" : (file.index + file.worktree).trim()) + "</span>"];
        })) + "</div>" +
        '<div class="panel"><h2>Recent commits</h2>' +
        table(["Commit", "Subject", "Author", "When"], data.commits.map(function (commit) {
          return ['<span class="mono">' + esc(commit.shortHash) + "</span>", esc(commit.subject),
            esc(commit.author), esc(shortDate(commit.date))];
        })) + "</div>");
    });
  },

  Sessions: function () {
    return api(projectPath("/sessions")).then(function (data) {
      render('<div class="panel"><h2>AI sessions</h2>' +
        table(["Agent", "Started", "Summary", "Next step", "Files"], data.sessions.map(function (session) {
          return [esc(session.agent) + ' <span class="badge ' + (session.status === "active" ? "good" : "") + '">' +
            esc(session.status) + "</span>", esc(shortDate(session.startedAt)),
            esc(session.summary || "-"), esc(session.nextStep || "-"), esc(session.filesChanged.length)];
        })) + "</div>");
    });
  },

  Code: function () {
    return api(projectPath("/architecture")).then(function (architecture) {
      return api(projectPath("/graph")).then(function (graph) {
        render('<div class="grid">' +
          card("Framework", architecture.framework || "-") +
          card("Languages", (architecture.languages || []).join(", ") || "-") +
          card("Packages", (architecture.external_packages || []).length) +
          card("Routes", (architecture.routes || []).length) + "</div>" +
          '<div class="panel"><h2>Most depended-on files</h2>' +
          table(["File", "Dependents", "Dependencies"], graph.files.map(function (file) {
            return [fileLink(file.path), esc(file.dependents), esc(file.dependencies)];
          })) + "</div>" +
          '<div class="panel"><h2>External packages</h2>' +
          table(["Package", "Files"], (architecture.external_packages || []).map(function (entry) {
            return [esc(entry.package), esc(entry.files)];
          })) + "</div>");
      });
    });
  },

  Search: function () {
    var query = state.query;
    var form = '<form class="inline" id="search-form"><input name="q" value="' + esc(query) +
      '" placeholder="Where is payment verification handled?" /><button class="primary">Search</button></form>';

    function bind() {
      el("search-form").addEventListener("submit", function (event) {
        event.preventDefault();
        state.query = String(new FormData(event.target).get("q") || "");
        load();
      });
    }

    if (!query) { render('<div class="panel"><h2>Search</h2>' + form + "</div>"); bind(); return Promise.resolve(); }

    return api(projectPath("/search?q=" + encodeURIComponent(query))).then(function (data) {
      render('<div class="panel"><h2>Search</h2>' + form +
        table(["Kind", "Match", "Where", "Relevance"], data.results.map(function (result) {
          return ['<span class="badge">' + esc(result.kind) + "</span>",
            esc(result.symbol ? result.symbol.name : (result.snippet ? result.snippet.text : result.path)),
            fileLink(result.path), esc(result.relevance)];
        })) + "</div>" +
        '<div class="panel"><h2>Related memory</h2>' +
        table(["Type", "Title"], data.memories.map(function (memory) {
          return ['<span class="badge">' + esc(memory.type) + "</span>", esc(memory.title)];
        })) + "</div>");
      bind();
    });
  },

  Analytics: function () {
    return api(projectPath("/analytics")).then(function (data) {
      render('<div class="grid">' +
        card("Requests", data.requests) +
        card("Cache hit rate", Math.round(data.hitRate * 100) + "%", data.hits + " hits, " + data.incremental + " incremental") +
        card("Average context", data.averageTokens + " tokens") +
        card("Files retrieved", data.filesRetrieved) +
        card("Files avoided", data.filesAvoided) +
        card("Tokens saved", "~" + data.estimatedTokensSaved) +
        card("Cached contexts", data.cachedEntries) + "</div>" +
        '<div class="panel"><h2>What this measures</h2><p class="muted">Every context request is recorded: ' +
        'whether it was served from cache, how many tokens it cost, and how many files it deliberately left out. ' +
        'These are counted, not estimated.</p></div>');
    });
  },

  /** PRD 32: what another agent - or you tomorrow - needs to carry on. */
  Handoff: function () {
    return api(projectPath("/handoff")).then(function (data) {
      var task = data.currentTask;

      var current = task
        ? '<div class="panel"><h2>Current task</h2>' +
          '<div class="row" style="justify-content:space-between">' +
          "<div><strong>" + esc(task.key) + "</strong> " + esc(task.title) + "</div>" +
          statusBadge(task.status) + "</div>" +
          '<div style="margin-top:10px">' + progressBar(task.progress) + "</div>" +
          (task.remaining.length
            ? '<ul class="plain" style="margin-top:10px">' +
              task.remaining.map(function (item) { return "<li>" + esc(item) + "</li>"; }).join("") + "</ul>"
            : "") +
          (task.blockedReason ? '<div class="muted" style="margin-top:8px">Blocked: ' + esc(task.blockedReason) + "</div>" : "") +
          "</div>"
        : '<div class="panel"><h2>Current task</h2><p class="empty">Nothing is in progress.</p></div>';

      var session = data.lastSession
        ? '<div class="panel"><h2>Last session</h2>' +
          '<div class="row"><span class="badge">' + esc(data.lastSession.agent) + "</span>" +
          '<span class="muted">' + esc(shortDate(data.lastSession.endedAt)) + "</span></div>" +
          (data.lastSession.summary ? "<p>" + esc(data.lastSession.summary) + "</p>" : "") +
          '<div class="split">' +
          "<div><h3 class=\"muted\">Completed</h3>" +
          (data.lastSession.completed.length
            ? '<ul class="plain">' + data.lastSession.completed.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>"
            : '<span class="muted">-</span>') + "</div>" +
          "<div><h3 class=\"muted\">Left</h3>" +
          (data.lastSession.remaining.length
            ? '<ul class="plain">' + data.lastSession.remaining.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>"
            : '<span class="muted">-</span>') + "</div></div>" +
          (data.lastSession.filesChanged.length
            ? '<div style="margin-top:10px">' + data.lastSession.filesChanged.map(fileLink).join(", ") + "</div>"
            : "") +
          "</div>"
        : '<div class="panel"><h2>Last session</h2><p class="empty">No session has been recorded yet.</p></div>';

      var knowledge = '<div class="split">' +
        '<div class="panel"><h2>Decisions</h2>' +
        (data.decisions.length
          ? '<ul class="plain">' + data.decisions.map(function (d) {
              return "<li>" + esc(d.title) + (d.reason ? ' <span class="muted">- ' + esc(d.reason) + "</span>" : "") + "</li>";
            }).join("") + "</ul>"
          : '<p class="empty">Nothing recorded.</p>') + "</div>" +
        '<div class="panel"><h2>Constraints</h2>' +
        (data.constraints.length
          ? '<ul class="plain">' + data.constraints.map(function (c) { return "<li>" + esc(c.title) + "</li>"; }).join("") + "</ul>"
          : '<p class="empty">Nothing recorded.</p>') + "</div></div>";

      var issues = data.knownIssues.length
        ? '<div class="panel"><h2>Known issues</h2>' +
          table(["Source", "Issue", "Detail"], data.knownIssues.map(function (issue) {
            return ['<span class="badge">' + esc(issue.source) + "</span>", esc(issue.title),
              '<span class="muted">' + esc(issue.detail) + "</span>"];
          })) + "</div>"
        : "";

      var changes = data.recentChanges.length
        ? '<div class="panel"><h2>Changed since the last commit</h2>' +
          data.recentChanges.map(fileLink).join(", ") + "</div>"
        : "";

      render('<div class="headline"><h3>Recommended next step</h3><div class="value">' +
        esc(data.recommendedNextStep) + "</div></div>" +
        current + session + knowledge + issues + changes);
    });
  },

  /** PRD 49: everything that needs attention, from the stores that hold it. */
  Issues: function () {
    return api(projectPath("/issues")).then(function (data) {
      var total = data.bugs.length + data.blocked_tasks.length + data.security.files;

      render('<div class="grid">' +
        card("Known bugs", data.bugs.length) +
        card("Blocked tasks", data.blocked_tasks.length) +
        card("Files with credentials", data.security.files) +
        card("Total", total) + "</div>" +

        '<div class="panel"><h2>Known bugs</h2>' +
        table(["Title", "Detail", "Files"], data.bugs.map(function (bug) {
          return [esc(bug.title), '<span class="muted">' + esc(String(bug.content).slice(0, 200)) + "</span>",
            (bug.paths || []).map(fileLink).join(", ")];
        })) + "</div>" +

        '<div class="panel"><h2>Blocked tasks</h2>' +
        table(["Key", "Title", "Blocked because"], data.blocked_tasks.map(function (task) {
          return ['<span class="mono">' + esc(task.key) + "</span>", esc(task.title),
            '<span class="muted">' + esc(task.blockedReason || "-") + "</span>"];
        })) + "</div>" +

        '<div class="panel"><h2>Files where a credential pattern was found</h2>' +
        '<p class="muted">DevMemory records that a detector fired and where - never the secret itself.</p>' +
        table(["File", "Detectors"], data.security.findings.map(function (finding) {
          return [fileLink(finding.path),
            finding.detectors.map(function (d) { return '<span class="badge warn">' + esc(d) + "</span>"; }).join(" ")];
        })) + "</div>");
    });
  },

  /** PRD 37, 38: what is being protected, and under what policy. */
  Security: function () {
    return api("/settings").then(function (settings) {
      return api(projectPath("/issues")).then(function (data) {
        var policy = settings.security.permissions;
        var guarded = policy.DESTRUCTIVE !== "allow";

        render('<div class="grid">' +
          card("Destructive ops", policy.DESTRUCTIVE, guarded ? "guarded" : "UNGUARDED") +
          card("Sensitive files", settings.security.blockSensitiveFiles ? "blocked" : "ALLOWED") +
          card("Secret redaction", settings.security.redactSecrets ? "on" : "OFF") +
          card("Secret scanning", settings.security.scanForSecrets ? "on" : "off") +
          card("Flagged files", data.security.files) + "</div>" +

          '<div class="panel"><h2>Operation policy</h2>' +
          '<p class="muted">Every MCP tool declares one of these classes; the server checks it before the tool runs.</p>' +
          table(["Class", "Rule", "Covers"], [
            ["READ", '<span class="badge">' + esc(policy.READ) + "</span>", "queries, search, context, recall"],
            ["WRITE", '<span class="badge">' + esc(policy.WRITE) + "</span>", "indexing, memory, tasks, sessions"],
            ["EXECUTE", '<span class="badge">' + esc(policy.EXECUTE) + "</span>", "test and build runs"],
            ["DESTRUCTIVE", '<span class="badge ' + (guarded ? "good" : "bad") + '">' + esc(policy.DESTRUCTIVE) + "</span>",
              "deleting a project's intelligence"]
          ]) +
          '<p class="muted">Change these in ' + esc(settings.home) + "/config.json</p></div>" +

          '<div class="panel"><h2>Files where a credential pattern was found</h2>' +
          table(["File", "Detectors"], data.security.findings.map(function (finding) {
            return [fileLink(finding.path),
              finding.detectors.map(function (d) { return '<span class="badge warn">' + esc(d) + "</span>"; }).join(" ")];
          })) + "</div>");
      });
    });
  },

  File: function () {
    if (!state.file) { render('<p class="empty">No file selected.</p>'); return Promise.resolve(); }

    return api(projectPath("/file?path=" + encodeURIComponent(state.file))).then(function (data) {
      var impact = data.impact || { direct: [], transitive: [], tests: [], exported_symbols: [], total: 0 };

      var header = '<button class="back">&larr; Back to ' + esc(state.previousTab) + "</button>" +
        '<div class="panel"><div class="row" style="justify-content:space-between">' +
        '<h2 style="margin:0">' + esc(data.path) + "</h2>" +
        "<div class=\"row\">" + editorLink(data.absolute_path, 0, "Open in VS Code") +
        '<span class="badge">' + esc(data.language || "text") + "</span>" +
        '<span class="badge">' + esc(Math.round(data.size / 102.4) / 10) + " KB</span></div></div>" +
        '<div class="muted">Last modified ' + esc(shortDate(data.last_modified)) + "</div></div>";

      // What breaks if this changes - the question a file view exists to answer.
      var impactCards = '<div class="grid">' +
        card("Defines", data.symbols.length, "symbols") +
        card("Depends on", data.dependencies.length, "files") +
        card("Used by", data.dependents.length, "files") +
        card("Blast radius", impact.total, "files, depth 3") +
        card("Tests", impact.tests.length) + "</div>";

      var symbols = '<div class="panel"><h2>Symbols</h2>' +
        table(["Name", "Kind", "Line", "Exported", ""], data.symbols.map(function (symbol) {
          return [esc(symbol.qualifiedName), '<span class="badge">' + esc(symbol.type) + "</span>",
            esc(symbol.lineStart), symbol.exported ? '<span class="badge good">yes</span>' : "",
            editorLink(data.absolute_path, symbol.lineStart, "line " + symbol.lineStart)];
        })) + "</div>";

      var relations = '<div class="split">' +
        '<div class="panel"><h2>Depends on</h2>' +
        (data.dependencies.length
          ? "<ul>" + data.dependencies.map(function (edge) { return "<li>" + fileLink(edge.path) + "</li>"; }).join("") + "</ul>"
          : '<p class="empty">Nothing inside this project.</p>') +
        (data.imports.filter(function (i) { return i.isExternal; }).length
          ? '<div class="muted" style="margin-top:8px">External: ' +
            esc(data.imports.filter(function (i) { return i.isExternal; })
              .map(function (i) { return i.packageName; }).join(", ")) + "</div>"
          : "") + "</div>" +
        '<div class="panel"><h2>Used by</h2>' +
        (data.dependents.length
          ? "<ul>" + data.dependents.map(function (edge) { return "<li>" + fileLink(edge.path) + "</li>"; }).join("") + "</ul>"
          : '<p class="empty">Nothing imports this file.</p>') + "</div></div>";

      var blast = impact.transitive.length || impact.tests.length
        ? '<div class="split"><div class="panel"><h2>Also affected (indirect)</h2>' +
          (impact.transitive.length
            ? "<ul>" + impact.transitive.map(function (path) { return "<li>" + fileLink(path) + "</li>"; }).join("") + "</ul>"
            : '<p class="empty">Nothing beyond the direct users.</p>') + "</div>" +
          '<div class="panel"><h2>Tests to run</h2>' +
          (impact.tests.length
            ? "<ul>" + impact.tests.map(function (path) { return "<li>" + fileLink(path) + "</li>"; }).join("") + "</ul>"
            : '<p class="empty">No tests reach this file.</p>') + "</div></div>"
        : "";

      var memories = data.memories.length
        ? '<div class="panel"><h2>What DevMemory knows about this file</h2>' +
          table(["Type", "Title", "Content"], data.memories.map(function (memory) {
            return ['<span class="badge">' + esc(memory.type) + "</span>", esc(memory.title),
              '<span class="muted">' + esc(String(memory.content).slice(0, 160)) + "</span>"];
          })) + "</div>"
        : "";

      var history = data.history.length
        ? '<div class="panel"><h2>Recent commits touching this file</h2>' +
          table(["Commit", "Subject", "Author", "When"], data.history.map(function (commit) {
            return ['<span class="mono">' + esc(commit.hash) + "</span>", esc(commit.subject),
              esc(commit.author), esc(shortDate(commit.date))];
          })) + "</div>"
        : "";

      render(header + impactCards + symbols + relations + blast + memories + history);

      var back = document.querySelector("button.back");
      if (back) back.addEventListener("click", function () { state.tab = state.previousTab; drawTabs(); load(); });
    });
  },

  Settings: function () {
    return api("/settings").then(function (data) {
      render('<div class="panel"><h2>Settings</h2>' +
        table(["Setting", "Value"], [
          ["Home", '<span class="mono">' + esc(data.home) + "</span>"],
          ["Storage driver", esc(data.driver)],
          ["Log level", esc(data.log_level)],
          ["Parse symbols", esc(data.indexing.parseSymbols)],
          ["Respect .gitignore", esc(data.indexing.respectGitignore)],
          ["Max file size", esc(data.indexing.maxFileSizeBytes) + " bytes"],
          ["Block sensitive files", esc(data.security.blockSensitiveFiles)],
          ["Redact secrets", esc(data.security.redactSecrets)],
          ["Scan for secrets", esc(data.security.scanForSecrets)],
          ["Permissions", '<span class="mono">' + esc(JSON.stringify(data.security.permissions)) + "</span>"],
          ["Dashboard", esc(data.dashboard.host + ":" + data.dashboard.port)]
        ]) + '<p class="muted">Edit ' + esc(data.home) + '/config.json to change these.</p></div>');
    });
  }
};

function needsProject(tab) {
  return tab !== "Overview" && tab !== "Projects" && tab !== "Settings" && tab !== "Workspace";
}

function load() {
  if (needsProject(state.tab) && !state.projectId) {
    render('<p class="empty">Connect a project first: run <span class="mono">devmemory connect</span> in a project directory.</p>');
    return Promise.resolve();
  }
  return views[state.tab]().catch(function (error) {
    render('<div class="panel"><h2>Something went wrong</h2><pre>' + esc(error.message) + "</pre></div>");
  });
}

function drawTabs() {
  el("tabs").innerHTML = TABS.map(function (tab) {
    return '<button class="' + (tab === state.tab ? "active" : "") + '" data-tab="' + tab + '">' + tab + "</button>";
  }).join("");
  Array.prototype.forEach.call(el("tabs").children, function (button) {
    button.addEventListener("click", function () { state.tab = button.dataset.tab; drawTabs(); load(); });
  });
}

function boot() {
  drawTabs();
  fetch("/health").then(function (r) { return r.json(); }).then(function (health) {
    el("home").textContent = health.home;
  });

  api("/workspaces").then(function (data) {
    state.workspaces = data.workspaces;
    if (data.workspaces.length) state.workspace = data.workspaces[0].name;
    if (state.tab === "Workspace") load();
  });

  api("/projects").then(function (data) {
    state.projects = data.projects;
    if (data.projects.length) state.projectId = data.projects[0].project_id;
    el("project").innerHTML = data.projects.map(function (project) {
      return '<option value="' + esc(project.project_id) + '">' + esc(project.name) + "</option>";
    }).join("") || "<option>No projects</option>";
    load();
  });

  el("view").addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("[data-file]") : null;
    if (!link) return;
    event.preventDefault();
    openFile(link.getAttribute("data-file"), link.getAttribute("data-project"));
  });

  el("project").addEventListener("change", function (event) {
    state.projectId = event.target.value;
    state.file = null;
    if (state.tab === "File") state.tab = state.previousTab;
    drawTabs();
    load();
  });
  el("refresh").addEventListener("click", load);
  el("reindex").addEventListener("click", function () {
    if (!state.projectId) return;
    el("reindex").disabled = true;
    post(projectPath("/index"), {}).then(load).finally(function () { el("reindex").disabled = false; });
  });
}

boot();
</script>
</body>
</html>`;
