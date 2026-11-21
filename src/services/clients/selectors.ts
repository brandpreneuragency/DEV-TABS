import type { ClientNote } from '../../types/clients';
import type { Client, Project, Task } from '../../types';
import { isNoClient } from '../../stores/clientOverview';

export interface ClientOverviewWork {
  projects: Project[];
  tasks: Task[];
  prioritizedTasks: Task[];
  projectSummaries: {
    project: Project;
    total: number;
    open: number;
    completed: number;
    overdue: number;
    nextDueDate: string | null;
  }[];
  total: number;
  open: number;
  completed: number;
  overdue: number;
  dueToday: number;
  activeProjects: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const importanceRank = { high: 0, medium: 1, low: 2 };

function compareOpenTasks(left: Task, right: Task): number {
  // ISO dates sort chronologically; undated work follows every dated task.
  return Number(!left.date) - Number(!right.date)
    || compareText(left.date, right.date)
    || importanceRank[left.importance] - importanceRank[right.importance]
    || left.order - right.order
    || compareText(left.id, right.id);
}

export function selectClientOverviewWork(input: {
  clientId: string | null;
  projects: readonly Project[];
  tasks: readonly Task[];
  today: string;
}): ClientOverviewWork {
  const projects = input.clientId === null
    ? [...input.projects]
    : input.projects.filter((project) => project.clientId === input.clientId);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = input.tasks.filter((task) => !task.deletedAt && !task.parentTaskId && projectIds.has(task.projectId));
  const openTasks = tasks.filter((task) => task.status !== 'completed');
  const activeProjectIds = new Set(openTasks.map((task) => task.projectId));
  return {
    projects,
    tasks,
    prioritizedTasks: [...openTasks].sort(compareOpenTasks),
    projectSummaries: projects.map((project) => {
      const projectTasks = tasks.filter((task) => task.projectId === project.id);
      const projectOpen = projectTasks.filter((task) => task.status !== 'completed');
      const dates = projectOpen.map((task) => task.date).filter(Boolean).sort(compareText);
      return {
        project,
        total: projectTasks.length,
        open: projectOpen.length,
        completed: projectTasks.length - projectOpen.length,
        overdue: projectOpen.filter((task) => Boolean(task.date) && task.date < input.today).length,
        nextDueDate: dates[0] ?? null,
      };
    }),
    total: tasks.length,
    open: openTasks.length,
    completed: tasks.length - openTasks.length,
    overdue: openTasks.filter((task) => Boolean(task.date) && task.date < input.today).length,
    dueToday: openTasks.filter((task) => Boolean(task.date) && task.date === input.today).length,
    activeProjects: activeProjectIds.size,
  };
}

export function selectClientPortfolio(input: {
  clients: readonly Client[];
  projects: readonly Project[];
  tasks: readonly Task[];
  notes: readonly ClientNote[];
  today: string;
}): { client: Client; work: ClientOverviewWork; lastContact: ClientNote | null }[] {
  return input.clients.filter((client) => !isNoClient(client))
    .sort((left, right) => left.order - right.order
      || compareText(left.name, right.name) || compareText(left.id, right.id))
    .map((client) => ({
      client,
      work: selectClientOverviewWork({
        clientId: client.id, projects: input.projects, tasks: input.tasks, today: input.today,
      }),
      lastContact: selectClientOverviewNotes(input.notes.filter((note) => note.clientId === client.id)).lastContact,
    }));
}

function compareNotes(left: ClientNote, right: ClientNote): number {
  return right.occurredAt - left.occurredAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function selectClientOverviewNotes(notes: readonly ClientNote[]): {
  latest: ClientNote[];
  pinned: ClientNote[];
  lastContact: ClientNote | null;
} {
  const live = notes.filter((note) => note.deletedAt === undefined).sort(compareNotes);
  return {
    latest: live.slice(0, 5),
    pinned: live.filter((note) => note.pinned).slice(0, 5),
    lastContact: live.find((note) => note.kind === 'call' || note.kind === 'meeting') ?? null,
  };
}
