import { create } from "zustand";
import type {
  TaskInvocationStatus,
  TaskRemoved,
  TaskUpdated,
} from "@/lib/contracts/sse.generated";
import { getEventClient } from "@/lib/events";

type TaskStoreState = {
  tasksById: Record<string, TaskInvocationStatus>;
};

export const useTaskStore = create<TaskStoreState>(() => ({
  tasksById: {},
}));

let initialized = false;
let eventUnsubscribers: Array<() => void> = [];

function indexTasks(
  tasks: Array<TaskInvocationStatus>,
): Record<string, TaskInvocationStatus> {
  return Object.fromEntries(tasks.map((task) => [task.id, task]));
}

export function initializeTaskStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const events = getEventClient();
  eventUnsubscribers = [
    events.on("snapshot", (data) => {
      useTaskStore.setState({ tasksById: indexTasks(data.tasks) });
    }),
    events.on("task_updated", (data: TaskUpdated) => {
      useTaskStore.setState((state) => ({
        tasksById: {
          ...state.tasksById,
          [data.task.id]: data.task,
        },
      }));
    }),
    events.on("task_removed", (data: TaskRemoved) => {
      useTaskStore.setState((state) => {
        const next = { ...state.tasksById };
        delete next[data.id];
        return { tasksById: next };
      });
    }),
  ];
}

export function resetTaskStoreForTests(): void {
  for (const unsubscribe of eventUnsubscribers) {
    unsubscribe();
  }
  eventUnsubscribers = [];
  initialized = false;
  useTaskStore.setState({ tasksById: {} });
}
