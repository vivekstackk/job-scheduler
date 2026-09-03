import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  Github,
  Globe2,
  Layers3,
  LayoutDashboard,
  ListChecks,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Terminal,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";

type JobStatus = "active" | "paused" | "dead_letter";
type RunStatus = "running" | "success" | "failed";

type Job = {
  id: string;
  name: string;
  cronExpression: string;
  handlerType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  nextRunAt: string | null;
};

type JobRun = {
  id: string;
  jobId: string;
  attempt: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};


// VITE_API_URL wins when set at build time, so a fork or a preview deployment
// does not need a code change. The localhost branch keeps using the Vite proxy
// (see vite.config.ts) to avoid CORS in development.
const API =
  import.meta.env.VITE_API_URL?.replace(/\/$/, "") ||
  (window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "/api"
    : "https://job-scheduler-j948.onrender.com");

// The API leaves reads public and requires this header on POST/PUT/DELETE once
// its API_KEY is set. Baked into the bundle, so it is not a secret — it stops
// drive-by writes from anyone who finds the API URL, nothing more. Unset means
// the dashboard is read-only against a key-protected API, and writes surface
// the server's own 401 message.
const API_KEY = import.meta.env.VITE_API_KEY;

async function api<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  // Only declare a JSON body when there is one to declare. A bodyless DELETE
  // sent with Content-Type: application/json is rejected by a strict JSON
  // parser before it reaches the route — which is exactly how the delete button
  // failed: the row stayed put and the message was "Body cannot be empty when
  // content-type is set to 'application/json'".
  const hasBody =
    options?.body !== undefined && options?.body !== null;

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(hasBody
        ? { "Content-Type": "application/json" }
        : {}),
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
      ...(options?.headers || {}),
    },
  });

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;

    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // Keep the HTTP status message.
    }

    if (response.status === 401) {
      message = API_KEY
        ? `${message} — the configured VITE_API_KEY was rejected`
        : `${message} — this dashboard was built without VITE_API_KEY, so it is read-only`;
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/* ---------------------------------------------------------
   CONSOLE PREFERENCES

   The API exposes no settings resource, so anything the
   Settings page can genuinely persist lives in the browser.
   Kept in a tiny external store rather than React state so
   the free-standing date() / relative() formatters can read
   it without threading props through every page.
--------------------------------------------------------- */

type TimeFormat = "relative" | "short" | "iso";

type Prefs = {
  refreshMs: number;
  timeFormat: TimeFormat;
  denseRows: boolean;
};

const PREFS_KEY = "jobscheduler.console.prefs";

const DEFAULT_PREFS: Prefs = {
  refreshMs: 15000,
  timeFormat: "relative",
  denseRows: false,
};

function readPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;

    const parsed = JSON.parse(raw) as Partial<Prefs>;

    return {
      refreshMs:
        typeof parsed.refreshMs === "number" &&
        parsed.refreshMs >= 0
          ? parsed.refreshMs
          : DEFAULT_PREFS.refreshMs,
      timeFormat:
        parsed.timeFormat === "short" ||
        parsed.timeFormat === "iso" ||
        parsed.timeFormat === "relative"
          ? parsed.timeFormat
          : DEFAULT_PREFS.timeFormat,
      denseRows: parsed.denseRows === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs: Prefs = readPrefs();

const prefsListeners = new Set<() => void>();

function setPref<K extends keyof Prefs>(
  key: K,
  value: Prefs[K]
) {
  prefs = { ...prefs, [key]: value };

  try {
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify(prefs)
    );
  } catch {
    // Private-browsing quota failures should not break the UI;
    // the preference still applies for this session.
  }

  prefsListeners.forEach((listener) => listener());
}

function usePrefs(): Prefs {
  const [snapshot, setSnapshot] = useState(prefs);

  useEffect(() => {
    const listener = () => setSnapshot(prefs);

    prefsListeners.add(listener);
    listener();

    return () => {
      prefsListeners.delete(listener);
    };
  }, []);

  return snapshot;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes an aria-modal sheet usable from the keyboard: focus moves in on
 * open, Escape closes, Tab cycles inside the sheet instead of wandering
 * into the page behind it, and focus returns to whatever opened it.
 *
 * Returns the ref to attach to the sheet element.
 */
function useDialog<T extends HTMLElement>(
  open: boolean,
  close: () => void
) {
  const sheet = useRef<T>(null);

  // Held in a ref so callers can pass an inline arrow without the effect
  // re-running — and re-stealing focus — on every render.
  const onClose = useRef(close);
  onClose.current = close;

  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement as HTMLElement | null;

    const node = sheet.current;

    // Prefer the first real field so a form sheet opens ready to type;
    // confirm sheets have no fields and fall back to their first button.
    const target =
      node?.querySelector<HTMLElement>(
        "input:not([disabled]), select:not([disabled]), textarea:not([disabled])"
      ) ?? node?.querySelector<HTMLElement>(FOCUSABLE);

    (target ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose.current();
        return;
      }

      if (event.key !== "Tab" || !node) return;

      const stops = Array.from(
        node.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null);

      if (stops.length === 0) return;

      const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
      if (document.activeElement !== edge) return;

      event.preventDefault();
      (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);

      // The sheet is already detached by the time this runs, so focus has
      // usually fallen back to <body>. Restore it then — but leave it
      // alone if a click elsewhere has already chosen a better target.
      const active = document.activeElement;
      const lost = !active || active === document.body;

      if (lost || node?.contains(active)) opener?.focus();
    };
  }, [open]);

  return sheet;
}


function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/dashboard/*" element={<Dashboard />} />
      <Route path="*" element={<Landing />} />
    </Routes>
  );
}

/* ---------------------------------------------------------
   BRAND
--------------------------------------------------------- */

function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link
      to="/"
      className={`brand ${inverse ? "inverse" : ""}`}
      aria-label="JobScheduler — home"
    >
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>

      <span className="brand-name">
        job<span>scheduler</span>
      </span>
    </Link>
  );
}

/* ---------------------------------------------------------
   LANDING
--------------------------------------------------------- */

function Landing() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timer = window.setTimeout(
      () => setCopied(false),
      2000
    );

    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="site">

      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="site-nav frame">

        <Brand />

        <nav aria-label="Sections">
          <a href="#system">System</a>
          <a href="#reliability">Reliability</a>
          <a href="#api">API</a>

          <a
            href="https://github.com/vivekstackk/job-scheduler"
            target="_blank"
            rel="noreferrer"
          >
            Source
          </a>
        </nav>

        <div className="nav-right">
          <Link to="/dashboard" className="quiet-link">
            Dashboard
          </Link>

          <button
            className="text-button"
            onClick={() => navigate("/dashboard")}
          >
            Open console
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>

      </header>

      <main id="main">

        {/* HERO */}

        <section className="hero frame">

          <div className="hero-left">

            <div className="overline">
              <span className="rule" aria-hidden="true" />
              BACKGROUND INFRASTRUCTURE
            </div>

            <h1>
              Jobs that run
              <br />
              <span>when they're due.</span>
            </h1>

            <p className="hero-lead">
              A small, fault-tolerant scheduler for cron-driven work.
              PostgreSQL locking, worker leases, retries and execution
              history — without another layer of ceremony.
            </p>

            <div className="hero-ctas">

              <button
                className="solid-button"
                onClick={() => navigate("/dashboard")}
              >
                Open dashboard
                <ArrowRight size={15} aria-hidden="true" />
              </button>

              <a
                className="outline-button"
                href="https://github.com/vivekstackk/job-scheduler"
                target="_blank"
                rel="noreferrer"
              >
                <Github size={15} aria-hidden="true" />
                Read the source
              </a>

            </div>

            <div className="hero-note">
              <span className="signal" aria-hidden="true" />
              3 workers healthy
              <span className="sep" aria-hidden="true">/</span>
              PostgreSQL connected
            </div>

          </div>

          {/* SCHEDULER VISUAL */}

          <div
            className="schedule-board"
            role="img"
            aria-label="Illustration of a production schedule: daily-report and user-sync completed, cleanup failed, backup queued."
          >

            <div className="board-head">
              <span>PRODUCTION / SCHEDULE</span>
              <span>UTC</span>
            </div>

            <div className="board-grid">

              <div className="time-rail">
                <span>08</span>
                <span>09</span>
                <span>10</span>
                <span>11</span>
                <span>12</span>
              </div>

              <div className="schedule-lanes">

                <ScheduleLane
                  name="daily-report"
                  start="14%"
                  width="22%"
                  state="done"
                />

                <ScheduleLane
                  name="user-sync"
                  start="36%"
                  width="14%"
                  state="done"
                />

                <ScheduleLane
                  name="cleanup"
                  start="52%"
                  width="17%"
                  state="failed"
                />

                <ScheduleLane
                  name="backup"
                  start="75%"
                  width="12%"
                  state="queued"
                />

              </div>

            </div>

            <div className="board-foot">
              <span>
                <b>04</b>
                scheduled
              </span>

              <span>
                <b>01</b>
                failed
              </span>

              <span>
                <b>02.1s</b>
                last duration
              </span>
            </div>

          </div>

        </section>

        {/* SYSTEM */}

        <section id="system" className="section frame">

          <div className="section-intro">

            <span className="overline">
              THE SYSTEM
            </span>

            <h2>
              A scheduler is a sequence
              of small guarantees.
            </h2>

            <p>
              Instead of hiding the infrastructure behind glossy
              abstractions, JobScheduler makes the important states visible.
            </p>

          </div>

          <div className="guarantees">

            <Guarantee
              n="01"
              title="Due"
              icon={<Clock3 aria-hidden="true" />}
              text="Cron expressions determine exactly when work becomes claimable."
            />

            <Guarantee
              n="02"
              title="Claimed"
              icon={<Layers3 aria-hidden="true" />}
              text="PostgreSQL row locking lets one worker take ownership safely."
            />

            <Guarantee
              n="03"
              title="Alive"
              icon={<Activity aria-hidden="true" />}
              text="A heartbeat lease proves the worker is still doing the work."
            />

            <Guarantee
              n="04"
              title="Recovered"
              icon={<RefreshCw aria-hidden="true" />}
              text="Stale leases can be reclaimed instead of leaving work stranded."
            />

          </div>

        </section>

        {/* RELIABILITY */}

        <section id="reliability" className="dark-band">

          <div className="frame reliability-layout">

            <div>

              <span className="overline">
                FAILURE IS PART OF THE MODEL
              </span>

              <h2>
                Workers can disappear.
                <br />
                <span>Jobs don't have to.</span>
              </h2>

              <p>
                That recovery path is the part worth showing.
                A lease expires, another worker sees the stale claim,
                and the job becomes executable again.
              </p>

            </div>

            <ol className="recovery-diagram">

              <li>
                <small>WORKER 01</small>
                <b>claims job</b>
                <span className="line" aria-hidden="true" />
              </li>

              <li className="broken">
                <small>LEASE</small>
                <b>expires</b>
                <span className="line" aria-hidden="true" />
              </li>

              <li>
                <small>WORKER 02</small>
                <b>reclaims job</b>
                <span className="line" aria-hidden="true" />
              </li>

            </ol>

          </div>

        </section>

        {/* API */}

        <section id="api" className="section frame api-section">

          <div className="api-copy">

            <span className="overline">
              SMALL API, CLEAR MODEL
            </span>

            <h2>
              Create a job
              <br />
              in one request.
            </h2>

            <p>
              The frontend is intentionally built around the API
              you already have. No backend rewrite required.
            </p>

            <Link
              to="/dashboard/jobs"
              className="inline-link"
            >
              Browse jobs
              <ArrowRight size={14} aria-hidden="true" />
            </Link>

          </div>

          <div className="code-sheet">

            <div className="code-title">
              <span>POST /jobs</span>

              <button
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(CREATE_JOB_SNIPPET)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
                aria-label="Copy request body"
              >
                {copied ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>

            <pre>{CREATE_JOB_SNIPPET}</pre>

          </div>

        </section>

      </main>

      <footer className="footer frame">

        <Brand />

        <span>
          Built for boring work that must happen.
        </span>

        <a
          href="https://github.com/vivekstackk/job-scheduler"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
          <ExternalLink size={13} aria-hidden="true" />
        </a>

      </footer>

    </div>
  );
}

// Has to stay a request the API would actually accept: an http job is
// validated against validateHttpPayload, which requires an absolute url.
const CREATE_JOB_SNIPPET = `{
  "name": "daily-report",
  "cronExpression": "0 9 * * *",
  "handlerType": "http",
  "payload": {
    "url": "https://api.example.com/reports/daily",
    "method": "POST",
    "timeoutMs": 10000
  }
}`;

function ScheduleLane({
  name,
  start,
  width,
  state,
}: {
  name: string;
  start: string;
  width: string;
  state: "done" | "failed" | "queued";
}) {
  return (
    <div className="lane">

      <span>{name}</span>

      <div
        className={`lane-bar ${state}`}
        style={{
          left: start,
          width,
        }}
      >
        <i />
      </div>

    </div>
  );
}

function Guarantee({
  n,
  title,
  icon,
  text,
}: {
  n: string;
  title: string;
  icon: ReactNode;
  text: string;
}) {
  return (
    <article className="guarantee">

      <div className="guarantee-top">
        <span>{n}</span>
        {icon}
      </div>

      <h3>{title}</h3>

      <p>{text}</p>

    </article>
  );
}

/* ---------------------------------------------------------
   DASHBOARD
--------------------------------------------------------- */

// Every client route the dashboard renders, so the breadcrumb names the page
// the user is actually on. A path missing from this map fell back to
// "Overview", which is how /dashboard/metrics used to read as "Overview"
// while showing metrics.
const CRUMBS: Record<string, string> = {
  "/": "Overview",
  "/jobs": "Jobs",
  "/runs": "Runs",
  "/schedules": "Schedules",
  "/metrics": "Metrics",
  "/api": "API",
  "/logs": "Logs",
  "/settings": "Settings",
};

function Dashboard() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Kept apart from `error` on purpose. loadDashboard() clears `error` on every
  // tick, so a failed pause or delete used to be wiped by the next poll — and it
  // rendered under the "API connection error" heading with a Retry button that
  // re-read the dashboard instead of retrying the action. This one says what did
  // not happen and stays until the user dismisses it.
  const [actionError, setActionError] = useState("");

  const location = useLocation();
  const preferences = usePrefs();

  const path =
    location.pathname.replace("/dashboard", "") || "/";

  async function loadDashboard() {
    try {
      setError("");

      const health = await api<{ status: string }>("/health");
      setOnline(health.status === "ok");

      const loadedJobs = await api<Job[]>("/jobs");
      setJobs(loadedJobs);

      // One request for all run history, ordered by the database. This used to
      // be a fetch per job with a `catch { return [] }` around each one, so a
      // single failing request silently became "no runs for that job" — the
      // page could not tell an empty history from a failed read.
      const loadedRuns = await api<JobRun[]>("/runs?limit=500");
      setRuns(loadedRuns);
    } catch (err) {
      setOnline(false);
      setError(
        err instanceof Error
          ? err.message
          : "Unable to connect to API"
      );
    } finally {
      setLoading(false);
    }
  }

  // Re-subscribes whenever the refresh preference changes so the new
  // cadence takes effect immediately instead of after the old tick.
  useEffect(() => {
    loadDashboard();

    if (preferences.refreshMs === 0) return;

    const interval = window.setInterval(
      loadDashboard,
      preferences.refreshMs
    );

    return () => window.clearInterval(interval);
  }, [preferences.refreshMs]);

  useEffect(() => {
    if (!mobileOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);

    return () =>
      window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  async function toggleJob(job: Job) {
    const nextStatus: JobStatus =
      job.status === "active" ? "paused" : "active";

    const previous = jobs;

    setActionError("");

    setJobs((current) =>
      current.map((item) =>
        item.id === job.id
          ? { ...item, status: nextStatus }
          : item
      )
    );

    try {
      const updated = await api<Job>(`/jobs/${job.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: nextStatus }),
      });

      setJobs((current) =>
        current.map((item) =>
          item.id === job.id ? updated : item
        )
      );
    } catch (err) {
      setJobs(previous);
      setActionError(
        `Could not ${
          nextStatus === "paused" ? "pause" : "resume"
        } ${job.name}: ${
          err instanceof Error ? err.message : "request failed"
        }`
      );
    }
  }

  // PUT /jobs/:id is a merge on the server: unspecified columns
  // keep their existing value, and passing cronExpression makes it
  // recompute next_run_at. So the response is the authority on when
  // the job fires next — always adopt it rather than guessing locally.
  async function updateJob(
    id: string,
    changes: Partial<{
      name: string;
      cronExpression: string;
      handlerType: string;
      payload: Record<string, unknown>;
      status: JobStatus;
    }>
  ) {
    const updated = await api<Job>(`/jobs/${id}`, {
      method: "PUT",
      body: JSON.stringify(changes),
    });

    setJobs((current) =>
      current.map((item) =>
        item.id === id ? updated : item
      )
    );

    return updated;
  }

  async function createJob(input: {
    name: string;
    cronExpression: string;
    handlerType: string;
    payload?: Record<string, unknown>;
  }) {
    const created = await api<Job>("/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });

    setJobs((current) => [created, ...current]);

    // A job created with a one-minute cron produces its first run within the
    // minute. Re-reading now (rather than waiting for the next poll tick, which
    // can be 30s away) is what makes Runs and Logs fill in promptly.
    loadDashboard();

    return created;
  }

  async function deleteJob(id: string) {
    const name =
      jobs.find((job) => job.id === id)?.name ?? "job";

    setActionError("");

    try {
      await api<void>(`/jobs/${id}`, {
        method: "DELETE",
      });

      setJobs((current) =>
        current.filter((job) => job.id !== id)
      );

      setRuns((current) =>
        current.filter((run) => run.jobId !== id)
      );
    } catch (err) {
      setActionError(
        `Could not delete ${name}: ${
          err instanceof Error ? err.message : "request failed"
        }`
      );
    }
  }

  return (
    <div
      className={`console-app ${
        preferences.denseRows ? "dense" : ""
      }`}
    >
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <aside
        className={`console-sidebar ${
          mobileOpen ? "open" : ""
        }`}
        aria-label="Console navigation"
      >
        <div className="console-brand">
          <Brand inverse />
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="environment">
          <span className="env-square" aria-hidden="true">
            P
          </span>
          <div>
            <b>Production</b>
            <small>
              {online ? "connected" : "offline"}
            </small>
          </div>
          <ChevronDown size={16} aria-hidden="true" />
        </div>

        <SideSection label="MONITOR">
          <SideLink
            to="/dashboard"
            icon={<LayoutDashboard aria-hidden="true" />}
            label="Overview"
            active={path === "/"}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/runs"
            icon={<Activity aria-hidden="true" />}
            label="Runs"
            active={path === "/runs"}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/jobs"
            icon={<ListChecks aria-hidden="true" />}
            label="Jobs"
            active={path === "/jobs"}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <SideSection label="MANAGE">
          <SideLink
            to="/dashboard/schedules"
            icon={<TimerReset aria-hidden="true" />}
            label="Schedules"
            active={path === "/schedules"}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/metrics"
            icon={<BarChart3 aria-hidden="true" />}
            label="Metrics"
            active={path === "/metrics"}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <SideSection label="DEVELOPER">
          <SideLink
            to="/dashboard/api"
            icon={<Code2 aria-hidden="true" />}
            label="API"
            active={path === "/api"}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/logs"
            icon={<Terminal aria-hidden="true" />}
            label="Logs"
            active={path === "/logs"}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/settings"
            icon={<Settings aria-hidden="true" />}
            label="Settings"
            active={path === "/settings"}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <div className="console-side-bottom">
          <div className="connection">
            <i
              className={online ? "online" : ""}
              aria-hidden="true"
            />
            {online ? "API connected" : "API offline"}
          </div>

          <div className="user-row">
            <span aria-hidden="true">VD</span>
            <div>
              <b>Vivek Damar</b>
              <small>Developer</small>
            </div>
            <MoreHorizontal size={17} aria-hidden="true" />
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
          tabIndex={-1}
        />
      )}

      <div className="console-content">
        <header className="console-header">
          <button
            type="button"
            className="mobile-menu"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
          >
            <Menu size={20} aria-hidden="true" />
          </button>

          <div className="crumb">
            Production
            <ChevronRight size={14} aria-hidden="true" />
            <b>{CRUMBS[path] ?? "Overview"}</b>
          </div>

          <div className="header-tools">
            <div className="search-box">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                id="console-search"
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="Search jobs"
                aria-label="Search jobs"
              />
            </div>

            <button
              type="button"
              onClick={loadDashboard}
              aria-label="Refresh data"
              title="Refresh data"
            >
              <RefreshCw size={17} aria-hidden="true" />
            </button>

            <Link
              to="/dashboard/settings"
              className="tool-link"
              aria-label="Settings"
              title="Settings"
            >
              <Settings size={17} aria-hidden="true" />
            </Link>
          </div>
        </header>

        {error && (
          <div className="api-error" role="alert">
            <span>API connection error: {error}</span>
            <button type="button" onClick={loadDashboard}>
              Retry
            </button>
          </div>
        )}

        {actionError && (
          <div className="api-error" role="alert">
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError("")}
            >
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div
            className="console-loading"
            role="status"
            aria-live="polite"
          >
            <div className="loading-line" aria-hidden="true" />
            <div
              className="loading-line short"
              aria-hidden="true"
            />
            <span>Loading scheduler data…</span>
          </div>
        ) : path === "/jobs" ? (
          <JobsPage
            jobs={jobs}
            search={search}
            toggle={toggleJob}
            createJob={createJob}
            deleteJob={deleteJob}
          />
        ) : path === "/runs" ? (
          <RunsPage jobs={jobs} runs={runs} />
        ) : path === "/schedules" ? (
          <SchedulesPage
            jobs={jobs}
            search={search}
            updateJob={updateJob}
          />
        ) : path === "/metrics" ? (
          <MetricsPage jobs={jobs} runs={runs} />
        ) : path === "/api" ? (
          <ApiPage />
        ) : path === "/logs" ? (
          <LogsPage jobs={jobs} runs={runs} search={search} />
        ) : path === "/settings" ? (
          <SettingsPage
            jobs={jobs}
            online={online}
            preferences={preferences}
            reload={loadDashboard}
            updateJob={updateJob}
          />
        ) : (
          <OverviewPage
            jobs={jobs}
            runs={runs}
            online={online}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   SIDEBAR
--------------------------------------------------------- */

function SideSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <nav className="side-group" aria-label={label}>

      <span>{label}</span>

      {children}

    </nav>
  );
}

function SideLink({
  to,
  icon,
  label,
  active,
  close,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  close: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={close}
      aria-current={active ? "page" : undefined}
      className={`console-link ${
        active ? "active" : ""
      }`}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

/* ---------------------------------------------------------
   OVERVIEW
--------------------------------------------------------- */

function OverviewPage({
  jobs,
  runs,
  online,
}: {
  jobs: Job[];
  runs: JobRun[];
  online: boolean;
}) {

  const active =
    jobs.filter(
      (job) => job.status === "active"
    ).length;

  const paused =
    jobs.filter(
      (job) => job.status === "paused"
    ).length;

  const dead =
    jobs.filter(
      (job) => job.status === "dead_letter"
    ).length;

  const successful =
    runs.filter(
      (run) => run.status === "success"
    ).length;

  return (
    <main className="console-page" id="main">

      <PageHead
        eyebrow={
          online
            ? "PRODUCTION / CONNECTED"
            : "API OFFLINE"
        }
        title="Overview"
        description="Scheduled work, worker health and recent execution."
        action={
          <Link
            className="solid-button"
            to="/dashboard/jobs"
          >
            <Plus size={16} aria-hidden="true" />
            New job
          </Link>
        }
      />

      <div className="metric-strip">

        <Metric
          label="Jobs"
          value={jobs.length}
          note={`${active} active`}
        />

        <Metric
          label="Successful runs"
          value={successful}
          note="loaded from API"
        />

        <Metric
          label="Failed runs"
          value={
            runs.filter(
              (run) => run.status === "failed"
            ).length
          }
          note="needs attention"
          danger
        />

        <Metric
          label="Success rate"
          value={
            runs.length === 0
              ? "—"
              : `${Math.round((successful / runs.length) * 100)}%`
          }
          note={
            runs.length === 0
              ? "no runs recorded yet"
              : `across ${runs.length} attempts`
          }
        />

      </div>

      <div className="overview-grid">

        <section className="surface activity-surface">

          <PanelTitle
            title="Execution activity"
            right="LAST 24 HOURS"
          />

          <ActivityChart runs={runs} />

        </section>

        <section className="surface status-surface">

          <PanelTitle
            title="Job status"
            right="CURRENT"
          />

          <div className="status-ring">

            <div>
              <b>{jobs.length}</b>
              <small>jobs</small>
            </div>

          </div>

          <div className="ring-key">

            <StatusKey
              color="green"
              label="Active"
              value={active}
            />

            <StatusKey
              color="gray"
              label="Paused"
              value={paused}
            />

            <StatusKey
              color="red"
              label="Dead letter"
              value={dead}
            />

          </div>

        </section>

        <section className="surface recent-surface">

          <PanelTitle
            title="Recent jobs"
            right={
              <Link to="/dashboard/jobs">
                VIEW ALL
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            }
          />

          <JobTable
            jobs={jobs.slice(0, 5)}
            caption="Five most recent jobs"
          />

        </section>

        <section className="surface recent-surface">

          <PanelTitle
            title="Recent runs"
            right={
              <Link to="/dashboard/runs">
                VIEW ALL
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            }
          />

          <div className="run-table">

            {runs.slice(0, 6).map((run) => (

              <RunRow
                key={run.id}
                run={run}
                name={
                  jobs.find(
                    (job) =>
                      job.id === run.jobId
                  )?.name || "unknown"
                }
              />

            ))}

            {runs.length === 0 && (
              <div className="empty-state">
                No execution history yet.
              </div>
            )}

          </div>

        </section>

      </div>

    </main>
  );
}

function Metric({
  label,
  value,
  note,
  danger,
}: {
  label: string;
  value: string | number;
  note: string;
  danger?: boolean;
}) {
  return (
    <div className="metric-cell">

      <span>{label}</span>

      <b>{value}</b>

      <small
        className={
          danger ? "danger-text" : ""
        }
      >
        {note}
      </small>

    </div>
  );
}

function PanelTitle({
  title,
  right,
  heading = false,
}: {
  title: string;
  right: ReactNode;
  /**
   * Panels on content-heavy pages opt into a real <h2> so screen-reader
   * users can jump between sections. The default stays a <b> because the
   * marketing panels sit inside their own heading hierarchy already.
   */
  heading?: boolean;
}) {
  return (
    <div className="panel-head">

      {heading ? <h2>{title}</h2> : <b>{title}</b>}

      <span>{right}</span>

    </div>
  );
}

/**
 * Buckets runs into the last 24 hours, oldest bucket first.
 *
 * Hour boundaries come from the browser clock so the axis matches the
 * timestamps shown elsewhere on the page.
 */
function hourlyBuckets(runs: JobRun[]) {
  const now = new Date();
  const top = new Date(now);
  top.setMinutes(0, 0, 0);

  const buckets = Array.from({ length: 24 }, (_, index) => {
    const at = new Date(top);
    at.setHours(top.getHours() - (23 - index));

    return { at, success: 0, failed: 0, running: 0 };
  });

  const first = buckets[0].at.getTime();

  for (const run of runs) {
    const started = new Date(run.startedAt).getTime();
    if (!Number.isFinite(started) || started < first) continue;

    const index = Math.min(
      23,
      Math.floor((started - first) / 3600000)
    );

    if (index < 0) continue;

    buckets[index][run.status] += 1;
  }

  return buckets;
}

function ActivityChart({ runs }: { runs: JobRun[] }) {
  const buckets = hourlyBuckets(runs);

  const total = buckets.reduce(
    (sum, bucket) => sum + bucket.success + bucket.failed,
    0
  );

  // A flat line at zero is indistinguishable from a broken chart, so an empty
  // history says so in words instead of drawing nothing.
  if (total === 0) {
    return (
      <div className="activity-chart">
        <div className="empty-state">
          No runs in the last 24 hours. The chart fills in as the worker
          executes scheduled jobs.
        </div>
      </div>
    );
  }

  const peak = Math.max(
    ...buckets.map((bucket) =>
      Math.max(bucket.success, bucket.failed)
    ),
    1
  );

  // viewBox units, matching the grid lines below.
  const width = 700;
  const height = 190;
  const floor = 166;
  const ceiling = 20;

  const points = (pick: (bucket: (typeof buckets)[number]) => number) =>
    buckets
      .map((bucket, index) => {
        const x = (index / (buckets.length - 1)) * width;
        const y =
          floor - (pick(bucket) / peak) * (floor - ceiling);

        return `${Math.round(x)},${Math.round(y)}`;
      })
      .join(" ");

  const failed = buckets.reduce(
    (sum, bucket) => sum + bucket.failed,
    0
  );

  const label = (bucket: (typeof buckets)[number]) =>
    `${pad(bucket.at.getHours())}:00`;

  return (
    <div className="activity-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Hourly executions over the last 24 hours: ${total} runs, ${failed} of them failed. Busiest hour had ${peak}.`}
      >
        {[35, 75, 115, 155].map((y) => (
          <line key={y} x1="0" x2={width} y1={y} y2={y} />
        ))}

        <polyline points={points((bucket) => bucket.success)} />

        <polyline
          className="failure-line"
          points={points((bucket) => bucket.failed)}
        />
      </svg>

      <div className="axis">
        <span>{label(buckets[0])}</span>
        <span>{label(buckets[6])}</span>
        <span>{label(buckets[12])}</span>
        <span>{label(buckets[18])}</span>
        <span>NOW</span>
      </div>

      <div className="chart-legend">
        <span>
          <i aria-hidden="true" />
          Successful runs
        </span>

        <span>
          <i className="failed" aria-hidden="true" />
          Failed runs
        </span>
      </div>
    </div>
  );
}

function StatusKey({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div>

      <i className={color} aria-hidden="true" />

      <span>{label}</span>

      <b>{value}</b>

    </div>
  );
}

function JobTable({
  jobs,
  caption,
}: {
  jobs: Job[];
  caption: string;
}) {
  return (
    <div className="table-scroll">

      <table>

        <caption className="sr-only">{caption}</caption>

        <thead>

          <tr>
            <th scope="col">JOB</th>
            <th scope="col">SCHEDULE</th>
            <th scope="col">STATUS</th>
            <th scope="col">NEXT RUN</th>
          </tr>

        </thead>

        <tbody>

          {jobs.map((job) => (

            <tr key={job.id}>

              <td>

                <Link
                  to={`/dashboard/jobs/${job.id}`}
                  className="job-cell"
                >

                  <i
                    aria-hidden="true"
                    className={
                      job.status === "active"
                        ? "green"
                        : job.status === "dead_letter"
                        ? "red"
                        : "gray"
                    }
                  />

                  {job.name}

                </Link>

              </td>

              <td>
                <code>
                  {job.cronExpression}
                </code>
              </td>

              <td>
                <Status status={job.status} />
              </td>

              <td>
                {nextRunLabel(job, relative)}
              </td>

            </tr>

          ))}

        </tbody>

      </table>

    </div>
  );
}

function RunRow({
  run,
  name,
}: {
  run: JobRun;
  name: string;
}) {
  return (
    <div className="run-line">

      <i
        aria-hidden="true"
        className={
          run.status === "success"
            ? "green"
            : "red"
        }
      />

      <div>

        <b>{name}</b>

        <small>
          {run.id} · attempt {run.attempt}
        </small>

      </div>

      <Status status={run.status} />

      <span>
        {relative(run.startedAt)}
      </span>

    </div>
  );
}

function Status({
  status,
}: {
  status: string;
}) {

  const tone =
    status === "active" ||
    status === "success"
      ? "green"
      : status === "failed" ||
        status === "dead_letter"
      ? "red"
      : status === "running"
      ? "blue"
      : "gray";

  const label =
    status === "dead_letter"
      ? "Dead letter"
      : status[0].toUpperCase() +
        status.slice(1);

  return (
    <span className={`status ${tone}`}>

      <i aria-hidden="true" />

      {label}

    </span>
  );
}

/* ---------------------------------------------------------
   JOBS
--------------------------------------------------------- */

function JobsPage({
  jobs,
  search,
  toggle,
  createJob,
  deleteJob,
}: {
  jobs: Job[];
  search: string;
  toggle: (job: Job) => Promise<void>;
  createJob: (input: {
    name: string;
    cronExpression: string;
    handlerType: string;
    payload?: Record<string, unknown>;
  }) => Promise<Job>;
  deleteJob: (id: string) => Promise<void>;
}) {
  const [filter, setFilter] =
    useState<"all" | JobStatus>("all");
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] =
    useState<Job | null>(null);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [handlerType, setHandlerType] =
    useState("http");
  // An http job is a request, so the form has to collect one. Before this the
  // dialog sent `payload: {}` and every created job had nothing to call.
  const [url, setUrl] = useState("");
  const [method, setMethod] = useState("GET");
  const [timeoutMs, setTimeoutMs] = useState("10000");
  const [headers, setHeaders] = useState("");
  const [requestBody, setRequestBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Kept in step with HTTP_HANDLERS in src/validation.ts — these are the two
  // handler types the API requires a url for.
  const needsUrl = handlerType === "http" || handlerType === "webhook";
  const allowsBody = method !== "GET" && method !== "HEAD";

  const confirmSheet = useDialog<HTMLDivElement>(
    confirmDelete !== null,
    () => setConfirmDelete(null)
  );
  const formSheet = useDialog<HTMLFormElement>(open, () =>
    setOpen(false)
  );

  useEffect(() => {
    if (!open && !confirmDelete) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setOpen(false);
      setConfirmDelete(null);
    }

    window.addEventListener("keydown", onKeyDown);

    return () =>
      window.removeEventListener("keydown", onKeyDown);
  }, [open, confirmDelete]);

  const filtered = jobs.filter(
    (job) =>
      `${job.name} ${job.cronExpression} ${job.handlerType}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || job.status === filter)
  );

  /**
   * Assembles the payload the http handler reads at execution time.
   *
   * Returns a string on failure so the dialog can explain the problem without
   * a round trip. Everything it does build is checked again by the API — this
   * is a convenience, not the validation boundary.
   */
  function buildPayload():
    | { payload: Record<string, unknown> }
    | { error: string } {
    if (!needsUrl) return { payload: {} };

    if (!url.trim()) {
      return {
        error:
          `A ${handlerType} job calls a URL — enter the endpoint the ` +
          "worker should request.",
      };
    }

    const payload: Record<string, unknown> = {
      url: url.trim(),
      method,
      timeoutMs: Number(timeoutMs),
    };

    if (headers.trim()) {
      try {
        const decoded: unknown = JSON.parse(headers);

        if (
          typeof decoded !== "object" ||
          decoded === null ||
          Array.isArray(decoded)
        ) {
          throw new Error("not an object");
        }

        payload.headers = decoded;
      } catch {
        return {
          error:
            'Headers must be a JSON object, e.g. {"authorization": "Bearer abc"}.',
        };
      }
    }

    // The API rejects a body on GET/HEAD, so don't send one the user cannot
    // see: the field is hidden for those methods.
    if (allowsBody && requestBody.trim()) {
      payload.body = requestBody;
    }

    return { payload };
  }

  async function create() {
    if (!name.trim()) return;

    setFormError("");

    const built = buildPayload();

    if ("error" in built) {
      setFormError(built.error);
      return;
    }

    setSaving(true);

    try {
      await createJob({
        name: name.trim(),
        cronExpression: cron.trim(),
        handlerType,
        payload: built.payload,
      });

      setName("");
      setCron("0 9 * * *");
      setHandlerType("http");
      setUrl("");
      setMethod("GET");
      setTimeoutMs("10000");
      setHeaders("");
      setRequestBody("");
      setOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : "Unable to create job"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="MANAGE"
        title="Jobs"
        description="Scheduled workloads and their current state."
        action={
          <button
            type="button"
            className="solid-button"
            onClick={() => setOpen(true)}
          >
            <Plus size={16} aria-hidden="true" />
            New job
          </button>
        }
      />

      <div
        className="filter-row"
        role="group"
        aria-label="Filter jobs by status"
      >
        {(
          [
            "all",
            "active",
            "paused",
            "dead_letter",
          ] as const
        ).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={filter === item}
            className={
              filter === item ? "selected" : ""
            }
            onClick={() => setFilter(item)}
          >
            {item === "all"
              ? "All"
              : item === "dead_letter"
              ? "Dead letter"
              : item[0].toUpperCase() +
                item.slice(1)}
          </button>
        ))}

        <span aria-live="polite">
          {filtered.length} jobs
        </span>
      </div>

      <section className="surface table-surface">
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Scheduled jobs
            </caption>

            <thead>
              <tr>
                <th scope="col">JOB</th>
                <th scope="col">SCHEDULE</th>
                <th scope="col">HANDLER</th>
                <th scope="col">STATUS</th>
                <th scope="col">NEXT RUN</th>
                <th scope="col">ACTION</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link
                      to={`/dashboard/jobs/${job.id}`}
                      className="job-cell"
                    >
                      <i
                        aria-hidden="true"
                        className={
                          job.status === "active"
                            ? "green"
                            : job.status === "dead_letter"
                            ? "red"
                            : "gray"
                        }
                      />
                      {job.name}
                    </Link>
                  </td>

                  <td>
                    <code>{job.cronExpression}</code>
                  </td>

                  <td>{job.handlerType}</td>

                  <td>
                    <Status status={job.status} />
                  </td>

                  <td>
                    {nextRunLabel(job, relative)}
                  </td>

                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        onClick={() => toggle(job)}
                        aria-label={
                          job.status === "active"
                            ? `Pause ${job.name}`
                            : `Resume ${job.name}`
                        }
                        title={
                          job.status === "active"
                            ? "Pause job"
                            : "Resume job"
                        }
                      >
                        {job.status === "active" ? (
                          <Pause
                            size={15}
                            aria-hidden="true"
                          />
                        ) : (
                          <Play
                            size={15}
                            aria-hidden="true"
                          />
                        )}
                      </button>

                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          setConfirmDelete(job)
                        }
                        aria-label={`Delete ${job.name}`}
                        title="Delete job"
                      >
                        <Trash2
                          size={15}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <div className="empty-state">
            <b>No jobs match this view.</b>
            <span>
              Clear the search or filter, or create a new
              scheduled job.
            </span>
          </div>
        )}
      </section>

      {confirmDelete && (
        <div
          className="modal-layer"
          onMouseDown={() => setConfirmDelete(null)}
        >
          <div
            className="form-sheet confirm-sheet"
            ref={confirmSheet}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onMouseDown={(event) =>
              event.stopPropagation()
            }
          >
            <div className="form-head">
              <div>
                <span>CONFIRM</span>
                <h2 id="confirm-title">Delete job</h2>
              </div>

              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                aria-label="Close dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <p className="confirm-copy">
              <b>{confirmDelete.name}</b> and its execution
              history will be removed. This cannot be undone.
            </p>

            <div className="form-foot">
              <button
                type="button"
                className="outline-button"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>

              <button
                type="button"
                className="solid-button danger"
                onClick={() => {
                  const target = confirmDelete;
                  setConfirmDelete(null);
                  deleteJob(target.id);
                }}
              >
                Delete job
              </button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div
          className="modal-layer"
          onMouseDown={() => setOpen(false)}
        >
          <form
            className="form-sheet"
            ref={formSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-job-title"
            onMouseDown={(event) =>
              event.stopPropagation()
            }
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <div className="form-head">
              <div>
                <span>NEW WORKLOAD</span>
                <h2 id="create-job-title">Create job</h2>
              </div>

              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div className="field">
              <label htmlFor="job-name">Name</label>

              <input
                id="job-name"
                value={name}
                onChange={(event) =>
                  setName(event.target.value)
                }
                placeholder="daily-report"
                aria-describedby="job-name-hint"
                autoComplete="off"
                required
              />

              <span
                className="field-hint"
                id="job-name-hint"
              >
                Lowercase, hyphen-separated.
              </span>
            </div>

            <div className="field">
              <label htmlFor="job-cron">
                Cron expression
              </label>

              <input
                id="job-cron"
                value={cron}
                onChange={(event) =>
                  setCron(event.target.value)
                }
                placeholder="0 9 * * *"
                aria-describedby="job-cron-hint"
                autoComplete="off"
                required
              />

              <span
                className="field-hint"
                id="job-cron-hint"
              >
                minute hour day month weekday — “0 9 * * *”
                runs at 09:00 daily.
              </span>
            </div>

            <div className="field">
              <label htmlFor="job-handler">
                Handler type
              </label>

              <select
                id="job-handler"
                value={handlerType}
                onChange={(event) =>
                  setHandlerType(
                    event.target.value
                  )
                }
                aria-describedby="job-handler-hint"
              >
                <option value="http">http</option>
                <option value="webhook">
                  webhook
                </option>
                <option value="noop">
                  noop
                </option>
              </select>

              <span
                className="field-hint"
                id="job-handler-hint"
              >
                {needsUrl
                  ? "The worker sends one request per run and records the response status."
                  : "noop records a run without calling anything — useful for testing the schedule."}
              </span>
            </div>

            {needsUrl && (
              <>
                <div className="field">
                  <label htmlFor="job-url">
                    Request URL
                  </label>

                  <input
                    id="job-url"
                    type="url"
                    value={url}
                    onChange={(event) =>
                      setUrl(event.target.value)
                    }
                    placeholder="https://api.example.com/tasks/refresh"
                    aria-describedby="job-url-hint"
                    autoComplete="off"
                    required
                  />

                  <span
                    className="field-hint"
                    id="job-url-hint"
                  >
                    Absolute http or https URL. This is what the worker calls.
                  </span>
                </div>

                <div className="field-row">
                  <div className="field">
                    <label htmlFor="job-method">
                      Method
                    </label>

                    <select
                      id="job-method"
                      value={method}
                      onChange={(event) =>
                        setMethod(event.target.value)
                      }
                    >
                      {[
                        "GET",
                        "POST",
                        "PUT",
                        "PATCH",
                        "DELETE",
                        "HEAD",
                        "OPTIONS",
                      ].map((verb) => (
                        <option key={verb} value={verb}>
                          {verb}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="job-timeout">
                      Timeout (ms)
                    </label>

                    <input
                      id="job-timeout"
                      type="number"
                      min={1}
                      max={120000}
                      step={500}
                      value={timeoutMs}
                      onChange={(event) =>
                        setTimeoutMs(event.target.value)
                      }
                      aria-describedby="job-timeout-hint"
                    />

                    <span
                      className="field-hint"
                      id="job-timeout-hint"
                    >
                      Aborts the request and fails the run. Max 120000.
                    </span>
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="job-headers">
                    Headers <small>optional</small>
                  </label>

                  <textarea
                    id="job-headers"
                    rows={2}
                    value={headers}
                    onChange={(event) =>
                      setHeaders(event.target.value)
                    }
                    placeholder={'{"authorization": "Bearer abc"}'}
                    aria-describedby="job-headers-hint"
                    spellCheck={false}
                  />

                  <span
                    className="field-hint"
                    id="job-headers-hint"
                  >
                    A JSON object of string values. Leave empty for none.
                  </span>
                </div>

                {allowsBody && (
                  <div className="field">
                    <label htmlFor="job-body">
                      Body <small>optional</small>
                    </label>

                    <textarea
                      id="job-body"
                      rows={3}
                      value={requestBody}
                      onChange={(event) =>
                        setRequestBody(event.target.value)
                      }
                      placeholder={'{"source": "scheduler"}'}
                      aria-describedby="job-body-hint"
                      spellCheck={false}
                    />

                    <span
                      className="field-hint"
                      id="job-body-hint"
                    >
                      Sent verbatim. Set a content-type header to match it.
                    </span>
                  </div>
                )}
              </>
            )}

            {formError && (
              <p className="form-error" role="alert">
                {formError}
              </p>
            )}

            <div className="form-foot">
              <button
                type="button"
                className="outline-button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>

              <button
                type="submit"
                className="solid-button"
                disabled={
                  saving ||
                  !name.trim() ||
                  (needsUrl && !url.trim())
                }
              >
                {saving ? "Creating…" : "Create job"}
                {!saving && (
                  <ArrowRight
                    size={15}
                    aria-hidden="true"
                  />
                )}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

/* ---------------------------------------------------------
   RUNS
--------------------------------------------------------- */

function RunsPage({
  jobs,
  runs,
}: {
  jobs: Job[];
  runs: JobRun[];
}) {
  const [filter, setFilter] =
    useState<"all" | RunStatus>("all");

  const filtered =
    filter === "all"
      ? runs
      : runs.filter(
          (run) => run.status === filter
        );

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="MONITOR"
        title="Runs"
        description="Every execution attempt, including retries and failures."
        action={
          <div className="live-label">
            <i aria-hidden="true" />
            LIVE DATA
          </div>
        }
      />

      <div
        className="filter-row"
        role="group"
        aria-label="Filter runs by status"
      >
        {(
          [
            "all",
            "success",
            "failed",
            "running",
          ] as const
        ).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={filter === item}
            className={
              filter === item ? "selected" : ""
            }
            onClick={() => setFilter(item)}
          >
            {item === "all"
              ? "All runs"
              : item[0].toUpperCase() +
                item.slice(1)}
          </button>
        ))}

        {/* "12 runs" next to an active filter reads as the whole history, so a
            filtered count always names the total it was taken from. */}
        <span aria-live="polite">
          {filter === "all"
            ? `${filtered.length} runs`
            : `${filtered.length} of ${runs.length} runs`}
        </span>
      </div>

      <section className="surface table-surface">
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Job execution history
            </caption>

            <thead>
              <tr>
                <th scope="col">STATUS</th>
                <th scope="col">RUN ID</th>
                <th scope="col">JOB</th>
                <th scope="col">ATTEMPT</th>
                <th scope="col">STARTED</th>
                <th scope="col">ENDED</th>
                <th scope="col">TOOK</th>
                <th scope="col">RESULT</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((run) => {
                const took = duration(
                  run.startedAt,
                  run.finishedAt
                );

                return (
                  <tr key={run.id}>
                    <td>
                      <Status status={run.status} />
                    </td>
                    <td>
                      <code>{run.id}</code>
                    </td>
                    <td>
                      {jobs.find(
                        (job) => job.id === run.jobId
                      )?.name || "unknown"}
                    </td>
                    <td>{run.attempt}</td>
                    <td>{date(run.startedAt)}</td>
                    <td>
                      {run.finishedAt
                        ? date(run.finishedAt)
                        : "Running"}
                    </td>
                    <td className="numeric">
                      {took === null
                        ? "—"
                        : humanDuration(took)}
                    </td>
                    {/* The reason a run failed was previously only visible in
                        Logs, so this table showed a red dot and nothing to act
                        on. The full text stays available on hover. */}
                    <td
                      className="reason-cell"
                      title={run.error ?? undefined}
                    >
                      {run.error ? (
                        <span className="danger-text">
                          {run.error}
                        </span>
                      ) : run.status === "success" ? (
                        "OK"
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* A status filter with no matches is not an empty history. Saying "no
            execution history yet" here told the user their runs were gone when
            they were one click away — the same distinction the Jobs, Schedules
            and Logs pages already make. */}
        {filtered.length === 0 && (
          <div className="empty-state">
            {runs.length === 0 ? (
              <>
                <b>No execution history yet.</b>
                <span>
                  Runs appear here as soon as a scheduled job
                  fires.
                </span>
              </>
            ) : (
              <>
                <b>No {filter} runs in this history.</b>
                <span>
                  {runs.length} run
                  {runs.length === 1 ? "" : "s"} recorded — switch
                  back to All runs to see them.
                </span>
              </>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

/* ---------------------------------------------------------
   SCHEDULES

   A cadence-first read of the same GET /jobs payload the rest
   of the console uses. The API exposes exactly one timestamp
   per job (nextRunAt), so everything past the imminent run is
   derived from the expression client-side and labelled as a
   projection rather than presented as fact.
--------------------------------------------------------- */

type UpdateJob = (
  id: string,
  changes: Partial<{
    name: string;
    cronExpression: string;
    handlerType: string;
    payload: Record<string, unknown>;
    status: JobStatus;
  }>
) => Promise<Job>;

const CRON_PRESETS: { label: string; expression: string }[] = [
  { label: "Every 5 min", expression: "*/5 * * * *" },
  { label: "Hourly", expression: "0 * * * *" },
  { label: "Daily 09:00", expression: "0 9 * * *" },
  { label: "Weekdays 09:00", expression: "0 9 * * 1-5" },
  { label: "Mondays 00:00", expression: "0 0 * * 1" },
  { label: "1st of month", expression: "0 0 1 * *" },
];

type Upcoming = { at: Date; source: "server" | "cron" };

// nextRunAt is what jobClaimer actually compares against, so it wins
// for the imminent fire. Later entries are extrapolated from the
// expression and tagged so the UI can say which is which.
function upcomingRuns(job: Job, count: number): Upcoming[] {
  const list: Upcoming[] = [];

  const server = job.nextRunAt ? new Date(job.nextRunAt) : null;
  const usable = server !== null && !Number.isNaN(server.getTime());

  if (usable) list.push({ at: server as Date, source: "server" });

  const anchor = usable ? (server as Date) : new Date();
  const from =
    anchor.getTime() > Date.now() ? anchor : new Date();

  for (const at of nextOccurrences(
    job.cronExpression,
    count - list.length,
    from
  )) {
    list.push({ at, source: "cron" });
  }

  return list;
}

// 1500 is one occurrence per minute for the full window, so even a
// "* * * * *" job is counted honestly rather than truncated.
function timelineBuckets(jobs: Job[]) {
  const now = new Date();

  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours()
    )
  );

  const horizon = start.getTime() + 24 * 3600000;

  const buckets = Array.from({ length: 24 }, (_, index) => ({
    at: new Date(start.getTime() + index * 3600000),
    count: 0,
  }));

  for (const job of jobs) {
    if (job.status !== "active") continue;

    for (const at of nextOccurrences(
      job.cronExpression,
      1500,
      now
    )) {
      if (at.getTime() >= horizon) break;

      const index = Math.floor(
        (at.getTime() - start.getTime()) / 3600000
      );

      if (index >= 0 && index < 24) buckets[index].count += 1;
    }
  }

  return buckets;
}

function SchedulesPage({
  jobs,
  search,
  updateJob,
}: {
  jobs: Job[];
  search: string;
  updateJob: UpdateJob;
}) {
  const [activeOnly, setActiveOnly] = useState(false);

  const term = search.trim().toLowerCase();

  const filtered = jobs.filter((job) => {
    if (activeOnly && job.status !== "active") return false;
    if (!term) return true;

    return (
      job.name.toLowerCase().includes(term) ||
      job.cronExpression.toLowerCase().includes(term)
    );
  });

  const buckets = timelineBuckets(jobs);
  const total = buckets.reduce((sum, item) => sum + item.count, 0);
  const peak = buckets.reduce(
    (max, item) => Math.max(max, item.count),
    0
  );
  const busiest = buckets.find((item) => item.count === peak);

  const unparsed = jobs.filter(
    (job) => parseCron(job.cronExpression) === null
  );

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="MANAGE"
        title="Schedules"
        description="Cadence, plain-language reading, and the next fires for every registered job."
        action={
          <div className="live-label">
            <i aria-hidden="true" />
            UTC
          </div>
        }
      />

      <section className="surface timeline-surface">
        <PanelTitle
          title="Next 24 hours"
          right={`${total} run${total === 1 ? "" : "s"} projected`}
          heading
        />

        <div
          className="timeline"
          role="img"
          aria-label={`Projected schedule load: ${total} runs across the next 24 hours${
            busiest && peak > 0
              ? `, peaking at ${pad(
                  busiest.at.getUTCHours()
                )}:00 UTC with ${peak}`
              : ""
          }.`}
        >
          {buckets.map((bucket, index) => (
            <div className="timeline-col" key={bucket.at.toISOString()}>
              <div className="timeline-track">
                <div
                  className="timeline-bar"
                  data-empty={bucket.count === 0 ? "true" : "false"}
                  style={{
                    height:
                      bucket.count === 0 || peak === 0
                        ? "2px"
                        : `${Math.max(
                            8,
                            Math.round((bucket.count / peak) * 100)
                          )}%`,
                  }}
                />
              </div>

              <span>
                {index % 3 === 0
                  ? `${pad(bucket.at.getUTCHours())}`
                  : ""}
              </span>
            </div>
          ))}
        </div>

        <p className="timeline-foot">
          Projected from each active expression in UTC — the same
          timezone <code>croner</code> uses server-side. Paused and
          dead-letter jobs are excluded.
        </p>
      </section>

      <div
        className="filter-row"
        role="group"
        aria-label="Filter schedules"
      >
        <button
          type="button"
          aria-pressed={!activeOnly}
          className={!activeOnly ? "selected" : ""}
          onClick={() => setActiveOnly(false)}
        >
          All schedules
        </button>

        <button
          type="button"
          aria-pressed={activeOnly}
          className={activeOnly ? "selected" : ""}
          onClick={() => setActiveOnly(true)}
        >
          Active only
        </button>

        <span aria-live="polite">
          {filtered.length} of {jobs.length} shown
        </span>
      </div>

      {unparsed.length > 0 && (
        <p className="inline-note" role="status">
          {unparsed.length} expression
          {unparsed.length === 1 ? "" : "s"} could not be read
          client-side ({unparsed
            .map((job) => job.name)
            .join(", ")}). The server still owns scheduling for
          those — only the local preview is unavailable.
        </p>
      )}

      <div className="schedule-grid">
        {filtered.map((job) => (
          <ScheduleCard
            key={job.id}
            job={job}
            updateJob={updateJob}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <section className="surface">
          <div className="empty-state">
            <b>No schedules match this view.</b>
            <span>
              Clear the search, or switch back to all schedules.
            </span>
          </div>
        </section>
      )}
    </main>
  );
}

function ScheduleCard({
  job,
  updateJob,
}: {
  job: Job;
  updateJob: UpdateJob;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(job.cronExpression);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const trimmed = draft.trim();
  const parsed = parseCron(trimmed);
  const changed = trimmed !== job.cronExpression;

  const upcoming = upcomingRuns(job, 4);
  const preview = parsed ? nextOccurrences(trimmed, 3) : [];

  function open() {
    setDraft(job.cronExpression);
    setError("");
    setEditing(true);
  }

  async function save() {
    if (!parsed) {
      setError("Five fields required: minute hour day month weekday.");
      return;
    }

    setSaving(true);
    setError("");

    try {
      await updateJob(job.id, { cronExpression: trimmed });
      setEditing(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update schedule"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="surface schedule-card">
      <div className="schedule-head">
        <div>
          <h3>{job.name}</h3>
          <p>{describeCron(job.cronExpression)}</p>
        </div>

        <Status status={job.status} />
      </div>

      <dl className="schedule-facts">
        <div>
          <dt>EXPRESSION</dt>
          <dd>
            <code>{job.cronExpression}</code>
          </dd>
        </div>

        <div>
          <dt>HANDLER</dt>
          <dd>
            <code>{job.handlerType}</code>
          </dd>
        </div>

        <div>
          <dt>NEXT RUN</dt>
          <dd>
            {nextRunLabel(job, date)}
          </dd>
        </div>
      </dl>

      {!editing && (
        <>
          <div className="upcoming">
            <span className="upcoming-label">
              UPCOMING · UTC
            </span>

            {upcoming.length === 0 ? (
              <p className="upcoming-empty">
                {job.status === "active"
                  ? "No future fires could be resolved from this expression."
                  : "Paused schedules are not claimed by the worker."}
              </p>
            ) : (
              <ol>
                {upcoming.map((item) => (
                  <li key={item.at.toISOString()}>
                    <code>{stamp(item.at)}</code>
                    <span>
                      {item.source === "server"
                        ? "server"
                        : "projected"}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <button
            type="button"
            className="outline-button"
            onClick={open}
          >
            Edit cadence
          </button>
        </>
      )}

      {editing && (
        <form
          className="cadence-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="field">
            <label htmlFor={`cron-${job.id}`}>
              Cron expression
            </label>

            <input
              id={`cron-${job.id}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-describedby={`cron-hint-${job.id}`}
              aria-invalid={parsed ? undefined : true}
              autoComplete="off"
              spellCheck={false}
              required
            />

            <span
              className="field-hint"
              id={`cron-hint-${job.id}`}
            >
              {parsed
                ? describeCron(trimmed)
                : "Five space-separated fields: minute hour day month weekday."}
            </span>
          </div>

          <div className="preset-row">
            {CRON_PRESETS.map((preset) => (
              <button
                key={preset.expression}
                type="button"
                onClick={() => setDraft(preset.expression)}
                aria-pressed={trimmed === preset.expression}
                className={
                  trimmed === preset.expression ? "selected" : ""
                }
              >
                {preset.label}
              </button>
            ))}
          </div>

          {parsed && preview.length > 0 && (
            <div className="upcoming preview">
              <span className="upcoming-label">
                {changed ? "WOULD RUN · UTC" : "RUNS · UTC"}
              </span>

              <ol>
                {preview.map((at) => (
                  <li key={at.toISOString()}>
                    {/* No source tag here: every line in the editor is a
                        projection from the draft expression, so labelling
                        each one "projected" only repeats the heading. */}
                    <code>{stamp(at)}</code>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="editor-foot">
            <button
              type="button"
              className="outline-button"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="solid-button"
              disabled={saving || !parsed || !changed}
            >
              {saving ? "Saving…" : "Save cadence"}
            </button>
          </div>

          <p className="editor-note">
            Saving sends <code>PUT /jobs/{job.id.slice(0, 8)}…</code>{" "}
            with the new expression. The server recomputes{" "}
            <code>next_run_at</code> and returns the stored row.
          </p>
        </form>
      )}
    </article>
  );
}

/* ---------------------------------------------------------
   METRICS

   Everything here is computed from the jobs and runs already
   loaded from the API. There is no metrics endpoint and no
   sampled data — the window is exactly the run history the
   dashboard fetched (/runs?limit=500).
--------------------------------------------------------- */

/** Percentile over an unsorted list of durations, nearest-rank. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );

  return sorted[index];
}

type JobMetrics = {
  job: Job;
  total: number;
  success: number;
  failed: number;
  running: number;
  durations: number[];
  lastRun: JobRun | null;
};

function perJobMetrics(jobs: Job[], runs: JobRun[]): JobMetrics[] {
  const rows = new Map<string, JobMetrics>(
    jobs.map((job) => [
      job.id,
      {
        job,
        total: 0,
        success: 0,
        failed: 0,
        running: 0,
        durations: [],
        lastRun: null,
      },
    ])
  );

  for (const run of runs) {
    const row = rows.get(run.jobId);

    // A run whose job has been deleted still exists in history if the delete
    // did not cascade; skip it rather than inventing a row for it.
    if (!row) continue;

    row.total += 1;
    row[run.status] += 1;

    const took = duration(run.startedAt, run.finishedAt);
    if (took !== null) row.durations.push(took);

    // /runs comes back newest first, so the first one seen is the latest.
    if (!row.lastRun) row.lastRun = run;
  }

  return [...rows.values()].sort((a, b) => b.total - a.total);
}

function MetricsPage({
  jobs,
  runs,
}: {
  jobs: Job[];
  runs: JobRun[];
}) {
  const success = runs.filter(
    (run) => run.status === "success"
  ).length;

  const failed = runs.filter(
    (run) => run.status === "failed"
  ).length;

  const running = runs.filter(
    (run) => run.status === "running"
  ).length;

  const finished = runs
    .map((run) => duration(run.startedAt, run.finishedAt))
    .filter((ms): ms is number => ms !== null);

  const p50 = percentile(finished, 50);
  const p95 = percentile(finished, 95);
  const slowest = finished.length
    ? Math.max(...finished)
    : null;

  const rate =
    runs.length === 0
      ? null
      : Math.round((success / runs.length) * 100);

  // Attempt 2 or 3 only exists because attempt 1 failed, so this is the
  // retry budget being spent — worth seeing on its own.
  const retries = runs.filter((run) => run.attempt > 1).length;

  const perJob = perJobMetrics(jobs, runs);
  const dead = jobs.filter(
    (job) => job.status === "dead_letter"
  );

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="MANAGE"
        title="Metrics"
        description="Execution outcomes and latency, computed from stored run history."
        action={
          <div className="live-label">
            <i aria-hidden="true" />
            {runs.length} RUNS IN WINDOW
          </div>
        }
      />

      <div className="metric-strip">
        <Metric
          label="Success rate"
          value={rate === null ? "—" : `${rate}%`}
          note={
            runs.length === 0
              ? "no runs recorded yet"
              : `${success} of ${runs.length} attempts`
          }
        />

        <Metric
          label="Failures"
          value={failed}
          note={
            retries === 0
              ? "no retries so far"
              : `${retries} retry attempts`
          }
          danger
        />

        <Metric
          label="Median duration"
          value={p50 === null ? "—" : humanDuration(p50)}
          note={
            p95 === null
              ? "waiting for finished runs"
              : `p95 ${humanDuration(p95)}`
          }
        />

        <Metric
          label="In flight"
          value={running}
          note={
            slowest === null
              ? "nothing finished yet"
              : `slowest ${humanDuration(slowest)}`
          }
        />
      </div>

      <section className="surface table-surface">
        <PanelTitle
          title="Per job"
          right="ALL LOADED RUNS"
          heading
        />

        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Execution outcomes and latency for each job
            </caption>

            <thead>
              <tr>
                <th scope="col">JOB</th>
                <th scope="col">HANDLER</th>
                <th scope="col">RUNS</th>
                <th scope="col">OK</th>
                <th scope="col">FAILED</th>
                <th scope="col">RATE</th>
                <th scope="col">MEDIAN</th>
                <th scope="col">LAST RUN</th>
              </tr>
            </thead>

            <tbody>
              {perJob.map((row) => {
                const median = percentile(row.durations, 50);

                return (
                  <tr key={row.job.id}>
                    <td>
                      <Link
                        to={`/dashboard/jobs/${row.job.id}`}
                        className="job-cell"
                      >
                        <i
                          aria-hidden="true"
                          className={
                            row.job.status === "active"
                              ? "green"
                              : row.job.status ===
                                  "dead_letter"
                                ? "red"
                                : "gray"
                          }
                        />
                        {row.job.name}
                      </Link>
                    </td>
                    <td>
                      <code>{row.job.handlerType}</code>
                    </td>
                    <td className="numeric">{row.total}</td>
                    <td className="numeric">
                      {row.success}
                    </td>
                    <td className="numeric">
                      {row.failed > 0 ? (
                        <span className="danger-text">
                          {row.failed}
                        </span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="numeric">
                      {row.total === 0
                        ? "—"
                        : `${Math.round(
                            (row.success / row.total) * 100
                          )}%`}
                    </td>
                    <td className="numeric">
                      {median === null
                        ? "—"
                        : humanDuration(median)}
                    </td>
                    <td>
                      {row.lastRun
                        ? date(row.lastRun.startedAt)
                        : "never"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {perJob.length === 0 && (
          <div className="empty-state">
            <b>No jobs registered.</b>
            <span>
              Create a job and its metrics appear here after the
              first run.
            </span>
          </div>
        )}
      </section>

      {dead.length > 0 && (
        <section className="surface">
          <PanelTitle
            title="Dead letter"
            right={`${dead.length} JOB${dead.length === 1 ? "" : "S"}`}
            heading
          />

          <p className="panel-note">
            executor.ts moves a job here after three failed attempts. It stops
            being claimed until something sets its status back to active — the
            Settings page has a recover action.
          </p>

          <div className="run-table">
            {dead.map((job) => {
              const row = perJob.find(
                (entry) => entry.job.id === job.id
              );

              return (
                <div className="dead-row" key={job.id}>
                  <b>{job.name}</b>

                  <code>{job.cronExpression}</code>

                  <span>
                    {row?.lastRun?.error ??
                      "no error recorded in the loaded window"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}

/* ---------------------------------------------------------
   API

   A reference for the service this dashboard talks to. The
   base URL and auth state are read from the live build, not
   written down — a preview deployment shows its own values.
--------------------------------------------------------- */

const ERROR_CONTRACT: {
  status: string;
  meaning: string;
  example: string;
}[] = [
  {
    status: "400",
    meaning: "The request was understood and rejected.",
    example:
      'cronExpression "* *" is not a valid cron / payload.url is required',
  },
  {
    status: "401",
    meaning: "A write without a valid x-api-key, once API_KEY is set.",
    example: "missing x-api-key header",
  },
  {
    status: "404",
    meaning: "No job with that id, or an unknown API path.",
    example: "job not found",
  },
  {
    status: "409",
    meaning: "The request conflicts with stored state.",
    example: "a record with that value already exists",
  },
  {
    status: "500",
    meaning:
      "A genuine bug. The stack is logged server-side; the response carries only a request id.",
    example: '{ "error": "internal server error", "requestId": "req-42" }',
  },
];

function ApiPage() {
  const base = API.startsWith("/")
    ? `${window.location.origin}${API}`
    : API;

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="DEVELOPER"
        title="API"
        description="The HTTP surface behind this dashboard, and what its errors mean."
        action={
          <a
            className="outline-button"
            href={`${base}/health`}
            target="_blank"
            rel="noreferrer"
          >
            Open /health
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        }
      />

      <section className="surface">
        <PanelTitle title="Connection" right="THIS BUILD" heading />

        <div className="fact-grid">
          <div>
            <span>Base URL</span>
            <code>{base}</code>
            <small>
              VITE_API_URL at build time, else "/api" on localhost — answered
              by the Vite proxy in dev, or by the API itself when one process
              serves both.
            </small>
          </div>

          <div>
            <span>Write auth</span>
            <code>{API_KEY ? "x-api-key sent" : "read-only"}</code>
            <small>
              {API_KEY
                ? "This build has VITE_API_KEY, so POST/PUT/DELETE are signed."
                : "No VITE_API_KEY in this build — writes fail if the API sets API_KEY."}
            </small>
          </div>

          <div>
            <span>Reads</span>
            <code>public</code>
            <small>
              GET never requires a key, which is what keeps /health usable as a
              probe.
            </small>
          </div>
        </div>
      </section>

      <section className="surface table-surface">
        <PanelTitle title="Endpoints" right="REST" heading />

        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Available API endpoints
            </caption>

            <thead>
              <tr>
                <th scope="col">METHOD</th>
                <th scope="col">PATH</th>
                <th scope="col">NOTE</th>
              </tr>
            </thead>

            <tbody>
              {ENDPOINTS.map((endpoint) => (
                <tr key={`${endpoint.method} ${endpoint.path}`}>
                  <td>
                    <code>{endpoint.method}</code>
                  </td>
                  <td>
                    <code>{endpoint.path}</code>
                  </td>
                  <td>{endpoint.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface">
        <PanelTitle title="Errors" right="CONTRACT" heading />

        <p className="panel-note">
          Every failure returns <code>{`{ "error": "..." }`}</code>. A
          validation failure adds <code>details</code> when more than one field
          is wrong. Stack traces stay in the server log.
        </p>

        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              What each status code means
            </caption>

            <thead>
              <tr>
                <th scope="col">STATUS</th>
                <th scope="col">MEANING</th>
                <th scope="col">EXAMPLE</th>
              </tr>
            </thead>

            <tbody>
              {ERROR_CONTRACT.map((entry) => (
                <tr key={entry.status}>
                  <td>
                    <code>{entry.status}</code>
                  </td>
                  <td>{entry.meaning}</td>
                  <td className="reason-cell" title={entry.example}>
                    {entry.example}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface">
        <PanelTitle title="Create a job" right="CURL" heading />

        <p className="panel-note">
          An <code>http</code> or <code>webhook</code> job is validated against
          <code>validateHttpPayload</code>: an absolute http/https URL is
          required, the method must be a standard verb, headers must be string
          values, and <code>timeoutMs</code> must be 1–120000. A{" "}
          <code>noop</code> job needs no payload.
        </p>

        <pre className="code-block">
          <code>{`curl -X POST ${base}/jobs \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: <your key>' \\
  -d '${CREATE_JOB_SNIPPET.replace(/\n\s*/g, " ")}'`}</code>
        </pre>
      </section>
    </main>
  );
}

/* ---------------------------------------------------------
   LOGS

   The API has no log endpoint — job_runs *is* the log. Each
   run row becomes one line, and a dead-letter job contributes
   one derived line because executor.ts flips that status once
   the retry budget is spent. Nothing here is invented beyond
   those two real sources.
--------------------------------------------------------- */

type LogLevel = "info" | "warn" | "error";

type LogLine = {
  id: string;
  at: string;
  level: LogLevel;
  event: string;
  jobName: string;
  attempt: number | null;
  message: string;
  detail: string | null;
};

const LOG_LEVELS: LogLevel[] = ["info", "warn", "error"];

function duration(startedAt: string, finishedAt: string | null) {
  if (!finishedAt) return null;

  const ms =
    new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function humanDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;

  return `${Math.floor(ms / 60000)}m ${Math.round(
    (ms % 60000) / 1000
  )}s`;
}

function buildLog(jobs: Job[], runs: JobRun[]): LogLine[] {
  const names = new Map(jobs.map((job) => [job.id, job.name]));

  // A failed attempt that was followed by another attempt is a retry,
  // not an outage — warn. Only the last failure for a job escalates.
  const highestAttempt = new Map<string, number>();

  for (const run of runs) {
    const current = highestAttempt.get(run.jobId) ?? 0;
    if (run.attempt > current) {
      highestAttempt.set(run.jobId, run.attempt);
    }
  }

  const lines: LogLine[] = [];

  for (const run of runs) {
    const name = names.get(run.jobId) ?? "unknown job";
    const took = duration(run.startedAt, run.finishedAt);
    const suffix = took === null ? "" : ` in ${humanDuration(took)}`;

    if (run.status === "running") {
      lines.push({
        id: `${run.id}-start`,
        at: run.startedAt,
        level: "info",
        event: "run.started",
        jobName: name,
        attempt: run.attempt,
        message: `attempt ${run.attempt} claimed and running`,
        detail: null,
      });

      continue;
    }

    if (run.status === "success") {
      lines.push({
        id: `${run.id}-ok`,
        at: run.finishedAt ?? run.startedAt,
        level: "info",
        event: "run.succeeded",
        jobName: name,
        attempt: run.attempt,
        message: `attempt ${run.attempt} succeeded${suffix}`,
        detail: null,
      });

      continue;
    }

    const retried = run.attempt < (highestAttempt.get(run.jobId) ?? 0);

    lines.push({
      id: `${run.id}-fail`,
      at: run.finishedAt ?? run.startedAt,
      level: retried ? "warn" : "error",
      event: "run.failed",
      jobName: name,
      attempt: run.attempt,
      message: retried
        ? `attempt ${run.attempt} failed${suffix} — retried`
        : `attempt ${run.attempt} failed${suffix}`,
      detail: run.error,
    });
  }

  // executor.ts writes status = 'dead_letter' after the retry budget
  // is spent. There is no row for that transition, so it is derived
  // from the job's status plus its failed attempts.
  for (const job of jobs) {
    if (job.status !== "dead_letter") continue;

    const failures = runs
      .filter(
        (run) => run.jobId === job.id && run.status === "failed"
      )
      .sort((a, b) => a.attempt - b.attempt);

    const last = failures[failures.length - 1];

    lines.push({
      id: `${job.id}-dead-letter`,
      at: last?.finishedAt ?? last?.startedAt ?? new Date().toISOString(),
      level: "error",
      event: "job.dead_letter",
      jobName: job.name,
      attempt: last?.attempt ?? null,
      message: failures.length
        ? `moved to dead_letter after ${failures.length} failed attempt${
            failures.length === 1 ? "" : "s"
          }`
        : "moved to dead_letter",
      detail: last?.error ?? null,
    });
  }

  // Newest first. The dead-letter line carries the same timestamp as the
  // final failure it was derived from, so the tie is broken in favour of
  // the transition — it happened after that failure, and a newest-first
  // list should read that way instead of relying on sort stability.
  return lines.sort((a, b) => {
    const gap = new Date(b.at).getTime() - new Date(a.at).getTime();
    if (gap !== 0) return gap;

    const rank = (line: LogLine) => (line.event === "job.dead_letter" ? 0 : 1);
    return rank(a) - rank(b);
  });
}

function LogsPage({
  jobs,
  runs,
  search,
}: {
  jobs: Job[];
  runs: JobRun[];
  search: string;
}) {
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<LogLine[] | null>(null);
  const [copied, setCopied] = useState(false);

  const live = buildLog(jobs, runs);
  const lines = frozen ?? live;

  const term = `${search} ${query}`.trim().toLowerCase();

  const filtered = lines.filter((line) => {
    if (level !== "all" && line.level !== level) return false;
    if (!term) return true;

    return `${line.jobName} ${line.event} ${line.message} ${
      line.detail ?? ""
    }`
      .toLowerCase()
      .includes(term);
  });

  const counts = {
    info: lines.filter((line) => line.level === "info").length,
    warn: lines.filter((line) => line.level === "warn").length,
    error: lines.filter((line) => line.level === "error").length,
  };

  async function copyView() {
    const text = filtered
      .map(
        (line) =>
          `${line.at} ${line.level.toUpperCase()} ${line.jobName} ${
            line.message
          }${line.detail ? ` :: ${line.detail}` : ""}`
      )
      .join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions; the view is unchanged.
    }
  }

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="DEVELOPER"
        title="Logs"
        description="Every run transition, newest first, derived from job_runs and job status."
        action={
          <button
            type="button"
            className={`stream-toggle ${frozen ? "paused" : ""}`}
            onClick={() =>
              setFrozen((current) => (current ? null : live))
            }
            aria-pressed={frozen !== null}
          >
            {frozen ? (
              <>
                <Play size={14} aria-hidden="true" />
                Resume stream
              </>
            ) : (
              <>
                <Pause size={14} aria-hidden="true" />
                Pause stream
              </>
            )}
          </button>
        }
      />

      <div className="log-toolbar">
        <div
          className="filter-row tight"
          role="group"
          aria-label="Filter log by level"
        >
          {(["all", ...LOG_LEVELS] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={level === item}
              className={level === item ? "selected" : ""}
              onClick={() => setLevel(item)}
            >
              {item === "all"
                ? "All"
                : `${capitalise(item)} ${
                    counts[item as LogLevel]
                  }`}
            </button>
          ))}
        </div>

        <div className="log-tools">
          <div className="search-box">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              id="log-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter lines"
              aria-label="Filter log lines"
            />
          </div>

          <button
            type="button"
            className="outline-button"
            onClick={copyView}
          >
            <Copy size={15} aria-hidden="true" />
            {copied ? "Copied" : "Copy view"}
          </button>
        </div>
      </div>

      <section
        className="surface log-surface"
        aria-labelledby="log-count"
      >
        <div className="log-head">
          {/* A real heading, so the stream is both a jump target and a
              named region — the count is the only sensible label for it. */}
          <h2 id="log-count">
            {filtered.length} line
            {filtered.length === 1 ? "" : "s"}
          </h2>

          <span aria-live="polite">
            {frozen
              ? "Stream paused — showing a frozen snapshot"
              : prefs.refreshMs === 0
              ? "Manual refresh only"
              : `Auto-refreshing every ${Math.round(
                  prefs.refreshMs / 1000
                )}s`}
          </span>
        </div>

        <ol className="log-list">
          {filtered.map((line) => (
            <LogRow
              key={line.id}
              line={line}
              open={expanded === line.id}
              toggle={() =>
                setExpanded((current) =>
                  current === line.id ? null : line.id
                )
              }
            />
          ))}
        </ol>

        {filtered.length === 0 && (
          <div className="empty-state">
            <b>Nothing logged for this view.</b>
            <span>
              Lines are written from execution history — clear the
              filter, or wait for the next run.
            </span>
          </div>
        )}
      </section>

      <p className="inline-note">
        Levels are derived, not stored: a failed attempt followed by a
        later attempt reads as a retry (warn), a final failure reads as
        an error, and the dead-letter line comes from the job&rsquo;s
        status once its retry budget is spent.
      </p>
    </main>
  );
}

function LogRow({
  line,
  open,
  toggle,
}: {
  line: LogLine;
  open: boolean;
  toggle: () => void;
}) {
  const hasDetail = Boolean(line.detail);

  return (
    <li className={`log-line level-${line.level}`}>
      <div className="log-main">
        <code className="log-time">{date(line.at)}</code>

        <span className={`log-level ${line.level}`}>
          {line.level.toUpperCase()}
        </span>

        <b className="log-job">{line.jobName}</b>

        <code className="log-event">{line.event}</code>

        <span className="log-message">{line.message}</span>

        {hasDetail && (
          <button
            type="button"
            className="log-expand"
            onClick={toggle}
            aria-expanded={open}
            aria-label={`${
              open ? "Hide" : "Show"
            } error detail for ${line.jobName}`}
          >
            <ChevronDown
              size={15}
              aria-hidden="true"
              className={open ? "flipped" : ""}
            />
          </button>
        )}
      </div>

      {hasDetail && open && (
        <pre className="log-detail">{line.detail}</pre>
      )}
    </li>
  );
}

/* ---------------------------------------------------------
   SETTINGS

   There is no settings resource on the API, so nothing here
   pretends to write server config. Console preferences are
   local (localStorage), the runtime block is a read-only
   record of the worker's compiled-in defaults, and the only
   mutations offered are ones real endpoints support.
--------------------------------------------------------- */

const REFRESH_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: "Manual only" },
  { value: 5000, label: "5 seconds" },
  { value: 15000, label: "15 seconds" },
  { value: 30000, label: "30 seconds" },
  { value: 60000, label: "60 seconds" },
];

const TIME_CHOICES: { value: TimeFormat; label: string; hint: string }[] =
  [
    {
      value: "relative",
      label: "Relative",
      hint: "4m ago",
    },
    {
      value: "short",
      label: "Short",
      hint: "Sep 02, 14:05",
    },
    {
      value: "iso",
      label: "ISO / UTC",
      hint: "2026-09-02 14:05Z",
    },
  ];

const RUNTIME_FACTS: { label: string; value: string; note: string }[] = [
  {
    label: "Poll interval",
    value: "2000 ms",
    note: "runWorker.ts — POLL_INTERVAL_MS, how often the claimer looks for due work",
  },
  {
    label: "Lease duration",
    value: "15000 ms",
    note: "runWorker.ts — LEASE_DURATION_MS, over the worker.ts default of 30000",
  },
  {
    label: "Heartbeat",
    value: "5000 ms",
    note: "runWorker.ts — HEARTBEAT_INTERVAL_MS, over the worker.ts lease/3 default",
  },
  {
    label: "Max attempts",
    value: "3",
    note: "executor.ts — then the job is moved to dead_letter",
  },
  {
    label: "Retry backoff",
    value: "1000 ms × 2^(attempt-1)",
    note: "executor.ts — 1s, 2s, 4s …",
  },
  {
    label: "Cron timezone",
    value: "UTC",
    note: "scheduler.ts — new Cron(expr, { timezone: \"UTC\" })",
  },
  {
    label: "Claim strategy",
    value: "FOR UPDATE SKIP LOCKED",
    note: "jobClaimer.ts — safe for multiple workers",
  },
  {
    label: "Write auth",
    value: API_KEY ? "x-api-key sent" : "read-only",
    note: API_KEY
      ? "auth.ts — VITE_API_KEY is set, so writes are signed"
      : "auth.ts — no VITE_API_KEY in this build; writes 401 if the API sets API_KEY",
  },
];

const ENDPOINTS: { method: string; path: string; note: string }[] = [
  { method: "GET", path: "/health", note: "Liveness + server clock" },
  { method: "GET", path: "/jobs", note: "All jobs, oldest first" },
  { method: "POST", path: "/jobs", note: "Register a job — 201" },
  { method: "GET", path: "/jobs/:id", note: "One job — 404 if absent" },
  {
    method: "GET",
    path: "/jobs/:id/runs",
    note: "Attempt history, ascending",
  },
  {
    method: "GET",
    path: "/runs?limit=n",
    note: "Recent runs across every job, newest first",
  },
  {
    method: "PUT",
    path: "/jobs/:id",
    note: "Merge update — recomputes next_run_at",
  },
  { method: "DELETE", path: "/jobs/:id", note: "Remove job + runs — 204" },
];

type HealthCheck = {
  state: "idle" | "checking" | "ok" | "fail";
  latencyMs: number | null;
  timestamp: string | null;
  message: string;
};

function SettingsPage({
  jobs,
  online,
  preferences,
  reload,
  updateJob,
}: {
  jobs: Job[];
  online: boolean;
  preferences: Prefs;
  reload: () => void;
  updateJob: UpdateJob;
}) {
  const [check, setCheck] = useState<HealthCheck>({
    state: "idle",
    latencyMs: null,
    timestamp: null,
    message: "",
  });

  const [confirmRecover, setConfirmRecover] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recovered, setRecovered] = useState("");
  const [copied, setCopied] = useState(false);

  const recoverSheet = useDialog<HTMLDivElement>(confirmRecover, () =>
    setConfirmRecover(false)
  );

  const dead = jobs.filter((job) => job.status === "dead_letter");

  async function runHealthCheck() {
    setCheck({
      state: "checking",
      latencyMs: null,
      timestamp: null,
      message: "",
    });

    const started = performance.now();

    try {
      const body = await api<{ status: string; timestamp: string }>(
        "/health"
      );

      setCheck({
        state: body.status === "ok" ? "ok" : "fail",
        latencyMs: Math.round(performance.now() - started),
        timestamp: body.timestamp ?? null,
        message: body.status === "ok" ? "" : `Reported ${body.status}`,
      });
    } catch (err) {
      setCheck({
        state: "fail",
        latencyMs: Math.round(performance.now() - started),
        timestamp: null,
        message:
          err instanceof Error ? err.message : "Request failed",
      });
    }
  }

  // Sequential on purpose: this is a recovery action on a shared
  // scheduler, and a burst of parallel writes buys nothing when the
  // dead-letter list is small.
  async function reactivateAll() {
    setRecovering(true);
    setRecovered("");

    let done = 0;
    let failed = 0;

    for (const job of dead) {
      try {
        await updateJob(job.id, { status: "active" });
        done += 1;
      } catch {
        failed += 1;
      }
    }

    setRecovering(false);
    setConfirmRecover(false);

    setRecovered(
      failed === 0
        ? `Reactivated ${done} job${done === 1 ? "" : "s"}.`
        : `Reactivated ${done}, ${failed} failed.`
    );

    reload();
  }

  async function copyBase() {
    try {
      await navigator.clipboard.writeText(API);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be denied; nothing else to do.
    }
  }

  return (
    <main className="console-page" id="main">
      <PageHead
        eyebrow="DEVELOPER"
        title="Settings"
        description="Connection, console preferences, and the scheduler contract this UI is written against."
        action={
          <div className={`live-label ${online ? "" : "off"}`}>
            <i aria-hidden="true" />
            {online ? "API ONLINE" : "API OFFLINE"}
          </div>
        }
      />

      <section className="surface settings-block">
        <PanelTitle title="Connection" right="live" heading />

        <dl className="settings-grid">
          <div>
            <dt>API base URL</dt>
            <dd className="with-action">
              <code>{API}</code>
              <button
                type="button"
                className="ghost-button"
                onClick={copyBase}
                aria-label="Copy API base URL"
              >
                <Copy size={14} aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>

          <div>
            <dt>Resolved from</dt>
            <dd>
              {API === "/api"
                ? "Vite dev proxy (localhost)"
                : "Compiled production host"}
            </dd>
          </div>

          <div>
            <dt>Last health check</dt>
            <dd>
              {check.state === "idle"
                ? "Not run in this session"
                : check.state === "checking"
                ? "Checking…"
                : check.state === "ok"
                ? `ok · ${check.latencyMs}ms round trip`
                : `failed · ${check.message}`}
            </dd>
          </div>

          <div>
            <dt>Server clock</dt>
            <dd>
              {check.timestamp ? (
                <code>{check.timestamp}</code>
              ) : (
                "—"
              )}
            </dd>
          </div>

          <div>
            <dt>Refresh cadence</dt>
            <dd>
              {preferences.refreshMs === 0
                ? "Manual only"
                : `${preferences.refreshMs / 1000}s polling`}
            </dd>
          </div>
        </dl>

        <div className="settings-foot">
          <button
            type="button"
            className="solid-button"
            onClick={runHealthCheck}
            disabled={check.state === "checking"}
          >
            <Activity size={15} aria-hidden="true" />
            {check.state === "checking"
              ? "Checking…"
              : "Run health check"}
          </button>

          <button
            type="button"
            className="outline-button"
            onClick={reload}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reload console data
          </button>
        </div>
      </section>

      <section className="surface settings-block">
        <PanelTitle
          title="Console preferences"
          right="stored locally"
          heading
        />

        <div className="pref-row">
          <div className="pref-label">
            <label htmlFor="pref-refresh">Refresh interval</label>
            <span>
              How often the console re-reads <code>/jobs</code> and
              each job&rsquo;s runs.
            </span>
          </div>

          <select
            id="pref-refresh"
            value={preferences.refreshMs}
            onChange={(event) =>
              setPref("refreshMs", Number(event.target.value))
            }
          >
            {REFRESH_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="pref-row">
          <div className="pref-label">
            <legend>Timestamp format</legend>
            <span>
              Applies to every time shown in the console.
            </span>
          </div>

          <div className="radio-set">
            {TIME_CHOICES.map((choice) => (
              <label key={choice.value} className="radio-chip">
                <input
                  type="radio"
                  name="pref-time"
                  value={choice.value}
                  checked={preferences.timeFormat === choice.value}
                  onChange={() =>
                    setPref("timeFormat", choice.value)
                  }
                />
                <b>{choice.label}</b>
                <code>{choice.hint}</code>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="pref-row">
          <div className="pref-label">
            <label htmlFor="pref-dense">Dense tables</label>
            <span>
              Tightens row padding to fit more history on screen.
              Touch targets stay at 44px.
            </span>
          </div>

          <label className="switch">
            <input
              id="pref-dense"
              type="checkbox"
              checked={preferences.denseRows}
              onChange={(event) =>
                setPref("denseRows", event.target.checked)
              }
            />
            <span aria-hidden="true" />
            <b>{preferences.denseRows ? "On" : "Off"}</b>
          </label>
        </div>

        <p className="inline-note">
          Preferences live in <code>localStorage</code> under{" "}
          <code>{PREFS_KEY}</code> — this browser only. The API has no
          settings resource, so nothing here is sent to the server.
        </p>
      </section>

      <section className="surface settings-block">
        <PanelTitle title="Scheduler runtime" right="read-only" heading />

        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Worker and executor defaults
            </caption>

            <thead>
              <tr>
                <th scope="col">SETTING</th>
                <th scope="col">VALUE</th>
                <th scope="col">SOURCE</th>
              </tr>
            </thead>

            <tbody>
              {RUNTIME_FACTS.map((fact) => (
                <tr key={fact.label}>
                  <td>{fact.label}</td>
                  <td>
                    <code>{fact.value}</code>
                  </td>
                  <td className="muted-cell">{fact.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="inline-note">
          These are process-level settings read from the worker's
          environment at startup, with the defaults shown above. The
          API does not expose them, so they cannot be changed from
          this console — set the named variables and restart the
          worker to alter them.
        </p>
      </section>

      <section className="surface settings-block">
        <PanelTitle
          title="Recovery"
          right={`${dead.length} dead letter`}
          heading
        />

        <p className="settings-copy">
          A job moves to <code>dead_letter</code> after{" "}
          <b>3 failed attempts</b> and is then skipped by the claimer
          for good — it only claims{" "}
          <code>status = 'active' AND next_run_at &lt;= now()</code>.
          Reactivating restores both halves: the status goes back to{" "}
          <code>active</code> and <code>next_run_at</code> is
          recomputed from the moment you reactivate, so the job picks
          up at its next cron occurrence from now instead of at the
          stale time it was carrying while it was stopped. Missed runs
          are not replayed.
        </p>

        {dead.length === 0 ? (
          <p className="inline-note">
            Nothing to recover. Dead-letter jobs will be listed here.
          </p>
        ) : (
          <ul className="dead-list">
            {dead.map((job) => (
              <li key={job.id}>
                <b>{job.name}</b>
                <code>{job.cronExpression}</code>
                <span>
                  {describeCron(job.cronExpression)}
                  {" — resumes at its next occurrence once reactivated"}
                </span>
              </li>
            ))}
          </ul>
        )}

        {recovered && (
          <p className="inline-note ok" role="status">
            {recovered}
          </p>
        )}

        <div className="settings-foot">
          <button
            type="button"
            className="solid-button"
            onClick={() => setConfirmRecover(true)}
            disabled={dead.length === 0 || recovering}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Reactivate all
          </button>
        </div>
      </section>

      <section className="surface settings-block">
        <PanelTitle title="API surface" right="7 endpoints" heading />

        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              Endpoints this console calls
            </caption>

            <thead>
              <tr>
                <th scope="col">METHOD</th>
                <th scope="col">PATH</th>
                <th scope="col">PURPOSE</th>
              </tr>
            </thead>

            <tbody>
              {ENDPOINTS.map((endpoint) => (
                <tr key={`${endpoint.method} ${endpoint.path}`}>
                  <td>
                    <span className="verb">{endpoint.method}</span>
                  </td>
                  <td>
                    <code>{endpoint.path}</code>
                  </td>
                  <td className="muted-cell">{endpoint.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="inline-note">
          That is the whole surface. Updates are <code>PUT</code>, not{" "}
          <code>PATCH</code>, and the body is merged server-side, so
          partial updates are safe.
        </p>
      </section>

      {confirmRecover && (
        <div
          className="modal-layer"
          onMouseDown={() => setConfirmRecover(false)}
        >
          <div
            className="form-sheet confirm-sheet"
            ref={recoverSheet}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="recover-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="form-head">
              <div>
                <span>CONFIRM</span>
                <h2 id="recover-title">Reactivate dead letters</h2>
              </div>

              <button
                type="button"
                onClick={() => setConfirmRecover(false)}
                aria-label="Close dialog"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <p className="confirm-copy">
              {dead.length} job{dead.length === 1 ? "" : "s"} will go
              back to <b>active</b> and become eligible on the next
              poll. If the underlying failure is still there they will
              burn another 3 attempts and return to dead letter.
            </p>

            <div className="form-foot">
              <button
                type="button"
                className="outline-button"
                onClick={() => setConfirmRecover(false)}
                disabled={recovering}
              >
                Cancel
              </button>

              <button
                type="button"
                className="solid-button"
                onClick={reactivateAll}
                disabled={recovering}
              >
                {recovering ? "Reactivating…" : "Reactivate all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ---------------------------------------------------------
   CRON

   The API only returns nextRunAt (one timestamp, computed
   server-side by croner in UTC). To describe a cadence or
   preview the runs after the next one, the console has to
   read the expression itself — so these helpers deliberately
   mirror the server: five fields, UTC, Sunday = 0.
--------------------------------------------------------- */

type CronFields = {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
};

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const DAY_NAMES = [
  "sun", "mon", "tue", "wed", "thu", "fri", "sat",
];

const DAY_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

const MONTH_LABELS = [
  "January", "February", "March", "April",
  "May", "June", "July", "August",
  "September", "October", "November", "December",
];

function cronToken(
  token: string,
  names: string[],
  offset: number
): number | null {
  const index = names.indexOf(token.toLowerCase());
  if (index !== -1) return index + offset;

  if (!/^\d+$/.test(token)) return null;

  return Number(token);
}

// Expands one field ("*/15", "1-5", "0,30", "mon-fri") into the
// explicit list of values it matches. Returns null on anything
// it does not understand, so callers can fall back to showing
// the raw expression rather than a confidently wrong reading.
function expandField(
  field: string,
  min: number,
  max: number,
  names: string[] = [],
  offset = 0
): number[] | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    if (!part) return null;

    const [rangePart, stepPart] = part.split("/");

    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      return null;
    }

    const step = stepPart ? Number(stepPart) : 1;
    if (step < 1) return null;

    let from: number;
    let to: number;

    if (rangePart === "*" || rangePart === "?") {
      from = min;
      to = max;
    } else if (rangePart.includes("-")) {
      const [rawFrom, rawTo] = rangePart.split("-");

      const parsedFrom = cronToken(rawFrom, names, offset);
      const parsedTo = cronToken(rawTo, names, offset);

      if (parsedFrom === null || parsedTo === null) return null;

      from = parsedFrom;
      to = parsedTo;
    } else {
      const single = cronToken(rangePart, names, offset);
      if (single === null) return null;

      from = single;
      to = stepPart ? max : single;
    }

    if (from < min || to > max || from > to) return null;

    for (let value = from; value <= to; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) return null;

  return [...values].sort((a, b) => a - b);
}

function parseCron(expression: string): CronFields | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [rawMinute, rawHour, rawDom, rawMonth, rawDow] = fields;

  const minute = expandField(rawMinute, 0, 59);
  const hour = expandField(rawHour, 0, 23);
  const dayOfMonth = expandField(rawDom, 1, 31);
  const month = expandField(rawMonth, 1, 12, MONTH_NAMES, 1);
  const dayOfWeek = expandField(rawDow, 0, 7, DAY_NAMES, 0);

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    // Cron accepts both 0 and 7 for Sunday; normalise to 0 so
    // the values line up with Date#getUTCDay().
    dayOfWeek: [
      ...new Set(dayOfWeek.map((day) => (day === 7 ? 0 : day))),
    ].sort((a, b) => a - b),
    restrictsDayOfMonth: rawDom !== "*" && rawDom !== "?",
    restrictsDayOfWeek: rawDow !== "*" && rawDow !== "?",
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function listLabels(values: number[], labels: string[]) {
  const named = values.map((value) => labels[value]);

  if (named.length === 1) return named[0];
  if (named.length === 2) return `${named[0]} and ${named[1]}`;

  return `${named.slice(0, -1).join(", ")} and ${
    named[named.length - 1]
  }`;
}

function describeTimes(fields: CronFields): string {
  const { minute, hour } = fields;

  if (minute.length === 60 && hour.length === 24) {
    return "every minute";
  }

  if (hour.length === 24) {
    if (minute.length === 1) {
      return `every hour at :${pad(minute[0])}`;
    }

    const gaps = new Set(
      minute.slice(1).map((value, index) => value - minute[index])
    );

    if (gaps.size === 1 && minute[0] === 0) {
      return `every ${[...gaps][0]} minutes`;
    }

    return `${minute.length} times an hour`;
  }

  if (minute.length === 1 && hour.length === 1) {
    return `at ${pad(hour[0])}:${pad(minute[0])} UTC`;
  }

  if (minute.length === 1) {
    return `at ${hour
      .map((value) => `${pad(value)}:${pad(minute[0])}`)
      .join(", ")} UTC`;
  }

  return `${minute.length * hour.length} times a day`;
}

// Plain-language reading of a cron expression. Falls back to the
// raw expression when parseCron cannot vouch for the fields.
function describeCron(expression: string): string {
  const fields = parseCron(expression);
  if (!fields) return expression;

  const times = describeTimes(fields);

  const everyDay =
    !fields.restrictsDayOfMonth && !fields.restrictsDayOfWeek;

  const everyMonth = fields.month.length === 12;

  const parts: string[] = [];

  if (fields.restrictsDayOfWeek) {
    parts.push(
      `on ${listLabels(fields.dayOfWeek, DAY_LABELS)}`
    );
  }

  if (fields.restrictsDayOfMonth) {
    const days = fields.dayOfMonth
      .map((day) => String(day))
      .join(", ");

    parts.push(
      `on day ${days} of the month`
    );
  }

  if (!everyMonth) {
    parts.push(`in ${listLabels(fields.month.map((m) => m - 1), MONTH_LABELS)}`);
  }

  if (parts.length === 0) {
    const prefix = everyDay && times.startsWith("at ") ? "Daily " : "";
    return capitalise(`${prefix}${times}`);
  }

  return capitalise(`${times}, ${parts.join(", ")}`);
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const UTC_STAMP = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// Projections are computed in UTC, so they are rendered in UTC
// explicitly — unlike date(), which follows the display preference
// and the browser's local zone.
function stamp(value: Date) {
  return UTC_STAMP.format(value);
}

function matchesDay(fields: CronFields, moment: Date): boolean {
  const dom = fields.dayOfMonth.includes(moment.getUTCDate());
  const dow = fields.dayOfWeek.includes(moment.getUTCDay());

  // Standard cron: when both day fields are restricted they are
  // OR-ed, not AND-ed. croner follows the same rule server-side.
  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) {
    return dom || dow;
  }

  if (fields.restrictsDayOfMonth) return dom;
  if (fields.restrictsDayOfWeek) return dow;

  return true;
}

// Walks forward from `from` collecting the next `count` firing
// times in UTC. Skips whole months/days/hours that cannot match
// instead of stepping minute by minute, and gives up after a
// bounded search so a pathological expression cannot hang the tab.
function nextOccurrences(
  expression: string,
  count: number,
  from: Date = new Date()
): Date[] {
  const fields = parseCron(expression);
  if (!fields) return [];

  const found: Date[] = [];

  let cursor = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes()
    ) + 60000
  );

  const limit = new Date(cursor.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);

  let guard = 0;

  while (found.length < count && cursor < limit && guard < 200000) {
    guard += 1;

    if (!fields.month.includes(cursor.getUTCMonth() + 1)) {
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth() + 1,
          1,
          0,
          0
        )
      );
      continue;
    }

    if (!matchesDay(fields, cursor)) {
      cursor = new Date(
        Date.UTC(
          cursor.getUTCFullYear(),
          cursor.getUTCMonth(),
          cursor.getUTCDate() + 1,
          0,
          0
        )
      );
      continue;
    }

    if (!fields.hour.includes(cursor.getUTCHours())) {
      cursor = new Date(cursor.getTime());
      cursor.setUTCMinutes(0);
      cursor = new Date(cursor.getTime() + 3600000);
      continue;
    }

    if (!fields.minute.includes(cursor.getUTCMinutes())) {
      cursor = new Date(cursor.getTime() + 60000);
      continue;
    }

    found.push(new Date(cursor.getTime()));
    cursor = new Date(cursor.getTime() + 60000);
  }

  return found;
}

/**
 * What to show under a NEXT RUN heading.
 *
 * next_run_at is only recomputed while a job is active (see jobStore.update), so
 * a paused or dead-lettered job keeps whatever timestamp it had when it stopped.
 * Handed straight to relative() that renders as "3m ago" under a NEXT RUN
 * header, which reads as a run the scheduler missed rather than a job the user
 * deliberately stopped. Neither one is due, so neither one gets a time.
 */
function nextRunLabel(
  job: Job,
  format: (value: string) => string
): string {
  if (job.status === "paused") return "Paused — no next run";
  if (job.status === "dead_letter") return "Stopped after repeated failures";

  return job.nextRunAt ? format(job.nextRunAt) : "Not scheduled";
}

function relative(dateValue: string) {

  const difference =
    new Date(dateValue).getTime() -
    Date.now();

  const minutes = Math.round(
    Math.abs(difference) / 60000
  );

  if (minutes < 1) {
    return "now";
  }

  if (minutes < 60) {

    return difference > 0
      ? `in ${minutes}m`
      : `${minutes}m ago`;

  }

  const hours = Math.round(
    minutes / 60
  );

  if (hours < 48) {

    return difference > 0
      ? `in ${hours}h`
      : `${hours}h ago`;

  }

  // Monthly and weekly crons put real distances on screen — a dead-lettered
  // "30 2 1 * *" job is ~700 hours from its next fire, and "in 689h" is not
  // a number anyone can read. Roll over rather than counting hours forever.
  const days = Math.round(hours / 24);

  if (days < 60) {

    return difference > 0
      ? `in ${days}d`
      : `${days}d ago`;

  }

  const weeks = Math.round(days / 7);

  return difference > 0
    ? `in ${weeks}w`
    : `${weeks}w ago`;
}

function date(dateValue: string) {

  if (prefs.timeFormat === "relative") {
    return relative(dateValue);
  }

  if (prefs.timeFormat === "iso") {
    return new Date(dateValue)
      .toISOString()
      .replace("T", " ")
      .replace(".000Z", "Z");
  }

  return new Intl.DateTimeFormat(
    "en",
    {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }
  ).format(new Date(dateValue));
}
function PageHead({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <span>{eyebrow}</span>

        <h1>{title}</h1>

        <p>{description}</p>
      </div>

      {action && <div>{action}</div>}
    </div>
  );
}
export default App;