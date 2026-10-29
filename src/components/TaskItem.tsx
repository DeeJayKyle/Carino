import { useState } from 'react';
import { Icon } from './Icon';
import { post } from '../lib/api';
import { isQueued, writeOrQueue } from '../lib/sync';
import { dueLabel } from '../lib/format';
import { useToast } from './ui';

export function TaskItem({ task, onChanged, onOpen, showProject = true }: { task: any; onChanged?: (t: any) => void; onOpen?: (t: any) => void; showProject?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const done = task.status === 'done';
  const due = dueLabel(task.due_at, task.all_day);

  const toggle = async () => {
    setBusy(true);
    try {
      const opts = { label: `${done ? 'Reopen' : 'Complete'} “${task.title}”`, entity: `tasks:${task.id}` };
      if (done) {
        const t = await writeOrQueue('POST', `/tasks/${task.id}/reopen`, {}, opts);
        onChanged?.(isQueued(t) ? { ...task, status: 'open' } : t);
      } else {
        const r: any = await writeOrQueue('POST', `/tasks/${task.id}/complete`, {}, opts);
        if (isQueued(r)) {
          onChanged?.({ ...task, status: 'done' });
          toast('Completed on this device — it will sync when you’re back online');
          return;
        }
        onChanged?.(r.task);
        toast(r.next ? `Done. Next occurrence scheduled.` : `Completed “${task.title}”`, 'info', {
          label: 'Undo',
          run: () => post(`/tasks/${task.id}/reopen`).then((t) => onChanged?.(t)),
        });
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`task ${done ? 'done' : ''}`}>
      <button
        className={`check ${done ? 'done' : ''} ${task.priority === 1 && !done ? 'p1' : ''}`}
        onClick={toggle} disabled={busy} aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      >
        <Icon name="check" size={13} strokeWidth={3} />
      </button>
      <div className="grow" style={{ minWidth: 0, cursor: onOpen ? 'pointer' : undefined }} onClick={() => onOpen?.(task)}>
        <div className="title" style={{ fontWeight: 550 }}>{task.title}</div>
        <div className="meta">
          {due.text && <span className={due.overdue && !done ? 'overdue' : ''}><Icon name="calendar" size={12} style={{ verticalAlign: -1 }} /> {due.text}</span>}
          {task.next_reminder && !done && <span title="Reminder scheduled"><Icon name="bell" size={12} style={{ verticalAlign: -1 }} /></span>}
          {task.recurrence && <span title="Repeats"><Icon name="refresh" size={12} style={{ verticalAlign: -1 }} /> {task.recurrence.freq}</span>}
          {showProject && task.project_name && <span><Icon name="folder" size={12} style={{ verticalAlign: -1 }} /> {task.project_name}</span>}
          {task.subtask_count > 0 && <span>{task.subtask_done}/{task.subtask_count} subtasks</span>}
          {task.estimate_minutes && <span>{task.estimate_minutes} min</span>}
          {task.priority === 1 && <span className="badge danger">High</span>}
          {task.tags?.map((t: string) => <span key={t} className="badge">#{t}</span>)}
        </div>
      </div>
    </li>
  );
}
