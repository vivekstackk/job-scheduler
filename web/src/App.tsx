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
  X,
} from "lucide-react";

import {
  useEffect,
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


const API = "/api";

async function api<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
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

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
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
    <Link to="/" className={`brand ${inverse ? "inverse" : ""}`}>
      <span className="brand-mark">
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

  return (
    <div className="site">

      <header className="site-nav frame">

        <Brand inverse />

        <nav>
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
            <ArrowRight size={14} />
          </button>
        </div>

      </header>

      <main>

        {/* HERO */}

        <section className="hero frame">

          <div className="hero-left">

            <div className="overline">
              <span className="rule" />
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
                <ArrowRight size={15} />
              </button>

              <a
                className="outline-button"
                href="https://github.com/vivekstackk/job-scheduler"
                target="_blank"
                rel="noreferrer"
              >
                <Github size={15} />
                Read the source
              </a>

            </div>

            <div className="hero-note">
              <span className="signal" />
              3 workers healthy
              <span className="sep">/</span>
              PostgreSQL connected
            </div>

          </div>

          {/* SCHEDULER VISUAL */}

          <div className="schedule-board">

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
              icon={<Clock3 />}
              text="Cron expressions determine exactly when work becomes claimable."
            />

            <Guarantee
              n="02"
              title="Claimed"
              icon={<Layers3 />}
              text="PostgreSQL row locking lets one worker take ownership safely."
            />

            <Guarantee
              n="03"
              title="Alive"
              icon={<Activity />}
              text="A heartbeat lease proves the worker is still doing the work."
            />

            <Guarantee
              n="04"
              title="Recovered"
              icon={<RefreshCw />}
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

            <div className="recovery-diagram">

              <div>
                <small>WORKER 01</small>
                <b>claims job</b>
                <span className="line" />
              </div>

              <div className="broken">
                <small>LEASE</small>
                <b>expires</b>
                <span className="line" />
              </div>

              <div>
                <small>WORKER 02</small>
                <b>reclaims job</b>
                <span className="line" />
              </div>

            </div>

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
              <ArrowRight size={14} />
            </Link>

          </div>

          <div className="code-sheet">

            <div className="code-title">
              <span>POST /jobs</span>
              <Copy size={13} />
            </div>

            <pre>{`{
  "name": "daily-report",
  "cronExpression": "0 9 * * *",
  "handlerType": "http",
  "payload": {
    "endpoint": "/reports/daily"
  }
}`}</pre>

          </div>

        </section>

      </main>

      <footer className="footer frame">

        <Brand inverse />

        <span>
          Built for boring work that must happen.
        </span>

        <a
          href="https://github.com/vivekstackk/job-scheduler"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
          <ExternalLink size={12} />
        </a>

      </footer>

    </div>
  );
}

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

function Dashboard() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const location = useLocation();

  const path =
    location.pathname.replace("/dashboard", "") || "/";

  async function loadDashboard() {
    try {
      setError("");

      const health = await api<{ status: string }>("/health");
      setOnline(health.status === "ok");

      const loadedJobs = await api<Job[]>("/jobs");
      setJobs(loadedJobs);

      const jobRuns = await Promise.all(
        loadedJobs.map(async (job) => {
          try {
            return await api<JobRun[]>(`/jobs/${job.id}/runs`);
          } catch {
            return [];
          }
        })
      );

      setRuns(
        jobRuns
          .flat()
          .sort(
            (a, b) =>
              new Date(b.startedAt).getTime() -
              new Date(a.startedAt).getTime()
          )
      );
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

  useEffect(() => {
    loadDashboard();

    const interval = window.setInterval(loadDashboard, 15000);

    return () => window.clearInterval(interval);
  }, []);

  async function toggleJob(job: Job) {
    const nextStatus: JobStatus =
      job.status === "active" ? "paused" : "active";

    const previous = jobs;

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
      setError(
        err instanceof Error
          ? err.message
          : "Unable to update job"
      );
    }
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
    return created;
  }

  async function deleteJob(id: string) {
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
      setError(
        err instanceof Error
          ? err.message
          : "Unable to delete job"
      );
    }
  }

  return (
    <div className="console-app">
      <aside
        className={`console-sidebar ${
          mobileOpen ? "open" : ""
        }`}
      >
        <div className="console-brand">
          <Brand />
          <button onClick={() => setMobileOpen(false)}>
            <X size={17} />
          </button>
        </div>

        <div className="environment">
          <span className="env-square">P</span>
          <div>
            <b>Production</b>
            <small>
              {online ? "connected" : "offline"}
            </small>
          </div>
          <ChevronDown size={14} />
        </div>

        <SideSection label="MONITOR">
          <SideLink
            to="/dashboard"
            icon={<LayoutDashboard />}
            label="Overview"
            active={path === "/" || path === ""}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/runs"
            icon={<Activity />}
            label="Runs"
            active={path.startsWith("/runs")}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard/jobs"
            icon={<ListChecks />}
            label="Jobs"
            active={path.startsWith("/jobs")}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <SideSection label="MANAGE">
          <SideLink
            to="/dashboard/jobs"
            icon={<TimerReset />}
            label="Schedules"
            active={false}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard"
            icon={<BarChart3 />}
            label="Metrics"
            active={false}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <SideSection label="DEVELOPER">
          <SideLink
            to="/dashboard"
            icon={<Code2 />}
            label="API"
            active={false}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard"
            icon={<Terminal />}
            label="Logs"
            active={false}
            close={() => setMobileOpen(false)}
          />
          <SideLink
            to="/dashboard"
            icon={<Settings />}
            label="Settings"
            active={false}
            close={() => setMobileOpen(false)}
          />
        </SideSection>

        <div className="console-side-bottom">
          <div className="connection">
            <i className={online ? "online" : ""} />
            {online ? "API connected" : "API offline"}
          </div>

          <div className="user-row">
            <span>VD</span>
            <div>
              <b>Vivek Damar</b>
              <small>Developer</small>
            </div>
            <MoreHorizontal size={15} />
          </div>
        </div>
      </aside>

      <div className="console-content">
        <header className="console-header">
          <button
            className="mobile-menu"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={18} />
          </button>

          <div className="crumb">
            Production
            <ChevronRight size={12} />
            <b>
              {path.startsWith("/jobs")
                ? "Jobs"
                : path.startsWith("/runs")
                ? "Runs"
                : "Overview"}
            </b>
          </div>

          <div className="header-tools">
            <div className="search-box">
              <Search size={14} />
              <input
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
                placeholder="Search"
              />
            </div>

            <button
              onClick={loadDashboard}
              title="Refresh"
            >
              <RefreshCw size={15} />
            </button>

            <button>
              <Settings size={15} />
            </button>
          </div>
        </header>

        {error && (
          <div className="api-error">
            <span>API connection error: {error}</span>
            <button onClick={loadDashboard}>Retry</button>
          </div>
        )}

        {loading ? (
          <div className="console-loading">
            <div className="loading-line" />
            <div className="loading-line short" />
            <span>Loading scheduler data…</span>
          </div>
        ) : path.startsWith("/jobs") ? (
          <JobsPage
            jobs={jobs}
            search={search}
            toggle={toggleJob}
            createJob={createJob}
            deleteJob={deleteJob}
          />
        ) : path.startsWith("/runs") ? (
          <RunsPage jobs={jobs} runs={runs} />
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
    <div className="side-group">

      <span>{label}</span>

      {children}

    </div>
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
    <main className="console-page">

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
            <Plus size={15} />
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
          label="Workers"
          value="3"
          note="all healthy"
        />

      </div>

      <div className="overview-grid">

        <section className="surface activity-surface">

          <PanelTitle
            title="Execution activity"
            right="LAST 24 HOURS"
          />

          <ActivityChart />

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
                <ArrowRight size={12} />
              </Link>
            }
          />

          <JobTable jobs={jobs.slice(0, 5)} />

        </section>

        <section className="surface recent-surface">

          <PanelTitle
            title="Recent runs"
            right={
              <Link to="/dashboard/runs">
                VIEW ALL
                <ArrowRight size={12} />
              </Link>
            }
          />

          <div className="run-table">

            {runs.map((run) => (

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
}: {
  title: string;
  right: ReactNode;
}) {
  return (
    <div className="panel-head">

      <b>{title}</b>

      <span>{right}</span>

    </div>
  );
}

function ActivityChart() {
  return (
    <div className="activity-chart">

      <svg
        viewBox="0 0 700 190"
        preserveAspectRatio="none"
      >

        {[35, 75, 115, 155].map((y) => (
          <line
            key={y}
            x1="0"
            x2="700"
            y1={y}
            y2={y}
          />
        ))}

        <polyline points="0,145 30,132 60,137 90,104 120,112 150,78 180,94 210,60 240,86 270,48 300,70 330,54 360,82 390,39 420,63 450,46 480,92 510,57 540,69 570,33 600,58 630,43 660,72 700,50" />

        <polyline
          className="failure-line"
          points="0,166 70,166 140,166 210,166 280,166 350,166 420,166 490,151 560,166 630,138 700,166"
        />

      </svg>

      <div className="axis">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>NOW</span>
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

      <i className={color} />

      <span>{label}</span>

      <b>{value}</b>

    </div>
  );
}

function JobTable({
  jobs,
}: {
  jobs: Job[];
}) {
  return (
    <div className="table-scroll">

      <table>

        <thead>

          <tr>
            <th>JOB</th>
            <th>SCHEDULE</th>
            <th>STATUS</th>
            <th>NEXT RUN</th>
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
                {job.nextRunAt
                  ? relative(job.nextRunAt)
                  : "—"}
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

      <i />

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
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [handlerType, setHandlerType] =
    useState("http");
  const [saving, setSaving] = useState(false);

  const filtered = jobs.filter(
    (job) =>
      `${job.name} ${job.cronExpression} ${job.handlerType}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || job.status === filter)
  );

  async function create() {
    if (!name.trim()) return;

    setSaving(true);

    try {
      await createJob({
        name: name.trim(),
        cronExpression: cron.trim(),
        handlerType,
        payload: {},
      });

      setName("");
      setCron("0 9 * * *");
      setHandlerType("http");
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="console-page">
      <PageHead
        eyebrow="MANAGE"
        title="Jobs"
        description="Scheduled workloads and their current state."
        action={
          <button
            className="solid-button"
            onClick={() => setOpen(true)}
          >
            <Plus size={15} />
            New job
          </button>
        }
      />

      <div className="filter-row">
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

        <span>{filtered.length} jobs</span>
      </div>

      <section className="surface table-surface">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>JOB</th>
                <th>SCHEDULE</th>
                <th>HANDLER</th>
                <th>STATUS</th>
                <th>NEXT RUN</th>
                <th>ACTION</th>
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
                    {job.nextRunAt
                      ? relative(job.nextRunAt)
                      : "—"}
                  </td>

                  <td>
                    <div className="row-actions">
                      <button
                        onClick={() => toggle(job)}
                        title={
                          job.status === "active"
                            ? "Pause job"
                            : "Resume job"
                        }
                      >
                        {job.status === "active" ? (
                          <Pause size={13} />
                        ) : (
                          <Play size={13} />
                        )}
                      </button>

                      <button
                        onClick={() =>
                          deleteJob(job.id)
                        }
                        title="Delete job"
                      >
                        <X size={13} />
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
            No jobs found.
          </div>
        )}
      </section>

      {open && (
        <div
          className="modal-layer"
          onMouseDown={() => setOpen(false)}
        >
          <div
            className="form-sheet"
            onMouseDown={(event) =>
              event.stopPropagation()
            }
          >
            <div className="form-head">
              <div>
                <span>NEW WORKLOAD</span>
                <h2>Create job</h2>
              </div>

              <button
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <label>
              NAME
              <input
                value={name}
                onChange={(event) =>
                  setName(event.target.value)
                }
                placeholder="daily-report"
              />
            </label>

            <label>
              CRON EXPRESSION
              <input
                value={cron}
                onChange={(event) =>
                  setCron(event.target.value)
                }
                placeholder="0 9 * * *"
              />
            </label>

            <label>
              HANDLER TYPE
              <select
                value={handlerType}
                onChange={(event) =>
                  setHandlerType(
                    event.target.value
                  )
                }
              >
                <option value="http">http</option>
                <option value="webhook">
                  webhook
                </option>
                <option value="worker">
                  worker
                </option>
              </select>
            </label>

            <div className="form-foot">
              <button
                className="outline-button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>

              <button
                className="solid-button"
                onClick={create}
                disabled={saving}
              >
                {saving ? "Creating..." : "Create job"}
                {!saving && (
                  <ArrowRight size={14} />
                )}
              </button>
            </div>
          </div>
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
    <main className="console-page">
      <PageHead
        eyebrow="MONITOR"
        title="Runs"
        description="Every execution attempt, including retries and failures."
        action={
          <div className="live-label">
            <i />
            LIVE DATA
          </div>
        }
      />

      <div className="filter-row">
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

        <span>{filtered.length} runs</span>
      </div>

      <section className="surface table-surface">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>STATUS</th>
                <th>RUN ID</th>
                <th>JOB</th>
                <th>ATTEMPT</th>
                <th>STARTED</th>
                <th>ENDED</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((run) => (
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <div className="empty-state">
            No execution history found.
          </div>
        )}
      </section>
    </main>
  );
}

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

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

  return difference > 0
    ? `in ${hours}h`
    : `${hours}h ago`;
}

function date(dateValue: string) {

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