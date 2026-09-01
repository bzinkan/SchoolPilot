import { useEffect, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenCheck,
  ChevronDown,
  CircleAlert,
  Compass,
  Lightbulb,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { ThemeToggle } from "../../../components/ThemeToggle";

function searchableTopicText(topic) {
  return [
    topic.id,
    topic.phase,
    topic.title,
    topic.summary,
    topic.role,
    ...(topic.keywords || []),
    ...(topic.steps || []).flatMap((step) => [step.title, step.body]),
    ...(topic.tips || []),
    topic.warning,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function PhaseRoute({ phases, activePhase }) {
  return (
    <ol className="mt-8 grid gap-2 sm:grid-cols-5" aria-label="Guide route">
      {phases.map((phase, index) => (
        <li key={phase} className="relative">
          <div className={`flex min-h-16 items-center gap-3 rounded-xl border px-3 py-2 ${
            phase === activePhase
              ? "border-amber-300 bg-amber-300 text-slate-950 shadow-lg shadow-amber-950/20"
              : "border-white/15 bg-white/5 text-slate-200"
          }`}>
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-black ${
              phase === activePhase ? "bg-slate-950 text-amber-300" : "bg-white/10 text-white"
            }`}>
              {index + 1}
            </span>
            <span className="text-sm font-bold leading-tight">{phase}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TopicCard({ topic, expanded }) {
  return (
    <details
      id={`topic-${topic.id}`}
      className="group scroll-mt-28 overflow-hidden rounded-2xl border border-slate-200 bg-card shadow-sm transition-shadow open:shadow-lg dark:border-slate-800"
      open={expanded}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-400 sm:px-6">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-300 dark:bg-slate-100 dark:text-slate-950">
              {topic.phase}
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> {topic.role}
            </span>
          </div>
          <h3 className="text-lg font-bold tracking-tight text-foreground sm:text-xl">{topic.title}</h3>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">{topic.summary}</p>
        </div>
        <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground group-open:bg-amber-400 group-open:text-slate-950">
          <ChevronDown className="h-5 w-5 transition-transform duration-200 motion-reduce:transition-none group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>

      <div className="border-t border-slate-200 px-5 py-5 dark:border-slate-800 sm:px-6 sm:py-6">
        <ol className="grid gap-4">
          {topic.steps.map((step, index) => (
            <li key={`${topic.id}-${step.title}`} className="grid grid-cols-[2rem_1fr] gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-400 text-sm font-black text-slate-950" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <h4 className="font-bold text-foreground">{step.title}</h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        {topic.tips?.map((tip) => (
          <div key={tip} className="mt-5 flex gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-100">
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p><strong>Flight note:</strong> {tip}</p>
          </div>
        ))}

        {topic.warning ? (
          <div className="mt-5 flex gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p><strong>Check before continuing:</strong> {topic.warning}</p>
          </div>
        ) : null}

        {topic.route ? (
          <Button asChild className="mt-5 bg-slate-900 text-white hover:bg-slate-800 dark:bg-amber-400 dark:text-slate-950 dark:hover:bg-amber-300">
            <Link to={topic.route}>
              {topic.routeLabel || "Open this page"}
              <ArrowUpRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>
    </details>
  );
}

export function GuideLayout({
  guideLabel,
  title,
  description,
  phases,
  topics,
  backPath,
  backLabel = "Dashboard",
  tabs,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = (searchParams.get("q") || "").trim();
  const selectedTopic = searchParams.get("topic") || "";

  const visibleTopics = useMemo(() => {
    const normalizedQuery = query.toLocaleLowerCase();
    if (!normalizedQuery) return topics;
    return topics.filter((topic) => searchableTopicText(topic).includes(normalizedQuery));
  }, [query, topics]);

  const selected = topics.find((topic) => topic.id === selectedTopic) || null;
  const activePhase = selected?.phase || visibleTopics[0]?.phase || phases[0];

  useEffect(() => {
    if (!selected) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`topic-${selected.id}`);
      if (!target) return;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
      target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      target.querySelector("summary")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected]);

  const setParam = (name, value, options) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next, options);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-foreground dark:bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <Button asChild variant="ghost" className="text-slate-200 hover:bg-white/10 hover:text-white">
              <Link to={backPath}>
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" /> {backLabel}
              </Link>
            </Button>
            <ThemeToggle />
          </div>
        </div>
        <div className="relative overflow-hidden border-t border-white/10">
          <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-amber-400/15 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 left-1/4 h-72 w-72 rounded-full bg-sky-500/10 blur-3xl" />
          <div className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
            <div className="flex max-w-4xl items-center gap-3 text-xs font-black uppercase tracking-[0.22em] text-amber-300">
              <Compass className="h-5 w-5" aria-hidden="true" /> {guideLabel}
            </div>
            <h1 className="mt-4 max-w-4xl text-3xl font-black tracking-tight sm:text-5xl">{title}</h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300 sm:text-lg">{description}</p>
            <PhaseRoute phases={phases} activePhase={activePhase} />
          </div>
        </div>
      </header>

      <div className="border-b border-slate-200 bg-card dark:border-slate-800">
        <div className="mx-auto max-w-7xl px-4 pt-3 sm:px-6">{tabs}</div>
      </div>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="rounded-2xl border border-slate-200 bg-card p-4 shadow-sm dark:border-slate-800 sm:p-5" aria-labelledby="guide-search-label">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-xl">
              <label className="flex items-center gap-2 text-sm font-bold text-foreground" id="guide-search-label" htmlFor="guide-search">
                <Search className="h-4 w-4 text-amber-500" aria-hidden="true" /> Search the flight plan
              </label>
              <p className="mt-1 text-sm text-muted-foreground">Search an action, status, or problem. The URL keeps your search so you can share it.</p>
            </div>
            <div className="relative w-full lg:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="guide-search"
                value={query}
                onChange={(event) => setParam("q", event.target.value, { replace: true })}
                placeholder="Try “signed out”, “PIN”, or “Waypoint”"
                className="h-11 pl-10 pr-10"
                aria-describedby="guide-search-results"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setParam("q", "", { replace: true })}
                  className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                  aria-label="Clear guide search"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
          <p id="guide-search-results" className="mt-3 text-xs font-semibold text-muted-foreground" aria-live="polite">
            {visibleTopics.length} {visibleTopics.length === 1 ? "topic" : "topics"}{query ? ` matching “${query}”` : " in this guide"}
          </p>
        </section>

        <div className="mt-6 lg:hidden">
          <label htmlFor="guide-topic-select" className="mb-2 block text-sm font-bold">Jump to a topic</label>
          <select
            id="guide-topic-select"
            value={selectedTopic}
            onChange={(event) => setParam("topic", event.target.value)}
            className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            <option value="">Choose a topic</option>
            {visibleTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.phase}: {topic.title}</option>)}
          </select>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <nav className="sticky top-5 rounded-2xl border border-slate-200 bg-card p-3 shadow-sm dark:border-slate-800" aria-label={`${guideLabel} topics`}>
              <div className="flex items-center gap-2 px-2 pb-3 text-sm font-black uppercase tracking-[0.12em] text-slate-700 dark:text-slate-200">
                <BookOpenCheck className="h-4 w-4 text-amber-500" aria-hidden="true" /> Topics
              </div>
              <ul className="space-y-1">
                {visibleTopics.map((topic) => (
                  <li key={topic.id}>
                    <button
                      type="button"
                      onClick={() => setParam("topic", topic.id)}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                        selectedTopic === topic.id
                          ? "bg-amber-400 text-slate-950"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <span className="block text-[10px] font-black uppercase tracking-[0.12em] opacity-70">{topic.phase}</span>
                      <span className="mt-0.5 block leading-snug">{topic.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          <div>
            {visibleTopics.length === 0 ? (
              <section className="rounded-2xl border-2 border-dashed border-slate-300 bg-card px-6 py-14 text-center dark:border-slate-700" role="status">
                <Sparkles className="mx-auto h-8 w-8 text-amber-500" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-black">No route matches that search</h2>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Try a shorter phrase or search for the name of a page, status, or classroom action.</p>
                <Button type="button" variant="outline" className="mt-5" onClick={() => setParam("q", "", { replace: true })}>Clear search</Button>
              </section>
            ) : (
              <div className="space-y-10">
                {phases.map((phase) => {
                  const phaseTopics = visibleTopics.filter((topic) => topic.phase === phase);
                  if (phaseTopics.length === 0) return null;
                  return (
                    <section key={phase} aria-labelledby={`phase-${phase.toLocaleLowerCase().replaceAll(" ", "-")}`}>
                      <div className="mb-4 flex items-center gap-3">
                        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                        <h2 id={`phase-${phase.toLocaleLowerCase().replaceAll(" ", "-")}`} className="text-sm font-black uppercase tracking-[0.18em] text-slate-500 dark:text-slate-400">{phase}</h2>
                        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                      </div>
                      <div className="space-y-4">
                        {phaseTopics.map((topic) => (
                          <TopicCard key={topic.id} topic={topic} expanded={selectedTopic === topic.id || Boolean(query)} />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
