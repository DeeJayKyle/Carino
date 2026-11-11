/**
 * What a routine may use, in groups a person can understand. A routine with no list keeps the old
 * behaviour (everything the assistant can use). With a list, only those tools are offered to the
 * model and only those can run (enforced in the agent, not just the prompt). Anything consequential
 * inside an allowed group still waits for the user's approval.
 */

export type AccessGroup = {
  id: string;
  label: string;
  /** What it lets the routine look at, in plain words. */
  reads: string;
  /** What it lets the routine do, in plain words ('' if nothing). */
  does: string;
  /** Things in this group that always ask first ('' if none). */
  asks: string;
  tools: string[];
  prefixes?: string[];
};

/** Always allowed: looking things up in Carino itself, and understanding dates. */
export const BASIC_TOOLS = ['parse_datetime', 'get_daily_overview', 'list_tasks', 'search_knowledge', 'recall_memories', 'read_document', 'list_routines'];

export const ACCESS_GROUPS: AccessGroup[] = [
  {
    id: 'tasks', label: 'To-dos and reminders',
    reads: 'your to-dos', does: 'add, change and complete to-dos and set reminders', asks: 'deleting a to-do',
    tools: ['create_task', 'update_task', 'complete_task', 'reopen_task', 'create_reminder', 'create_place_reminder', 'delete_task'],
  },
  {
    id: 'web', label: 'The web',
    reads: 'web searches, places and public web pages', does: '', asks: '',
    tools: ['web_search', 'find_places', 'capture_page', 'prepare_call'],
  },
  {
    id: 'money', label: 'Money',
    reads: 'your spending, budgets, bills, debts and savings', does: 'log spending and income, mark bills paid and update savings', asks: '',
    tools: ['log_expense', 'set_budget', 'spending_summary', 'log_income', 'add_bill', 'pay_bill', 'record_debt', 'savings_goal'],
  },
  {
    id: 'applications', label: 'Applications',
    reads: 'your job and scholarship applications', does: 'update applications and checklists, and draft form answers as notes', asks: '',
    tools: ['track_application', 'application_checklist', 'list_applications', 'prepare_form_answers'],
  },
  {
    id: 'memory', label: 'Memories',
    reads: '', does: 'save and update things it remembers about you', asks: 'deleting a memory',
    tools: ['save_memory', 'update_memory', 'delete_memory'],
  },
  {
    id: 'email', label: 'Email and calendar',
    reads: 'your connected email and calendar', does: 'make to-dos from emails and write drafts (never sent)', asks: 'sending email or adding calendar events',
    tools: ['inbox_overview', 'email_to_task'],
    prefixes: ['gmail_', 'google_calendar_', 'outlook_'],
  },
  {
    id: 'documents', label: 'Online documents',
    reads: 'your Drive, OneDrive, Sheets, Docs and Excel files', does: 'create new documents', asks: 'changing existing documents',
    tools: [],
    prefixes: ['drive_', 'onedrive_', 'sheets_', 'docs_', 'word_', 'excel_', 'powerpoint_'],
  },
  {
    id: 'files', label: 'Folders on your devices',
    reads: 'the folders you shared with Carino', does: 'open files you shared', asks: 'moving, deleting or saving files',
    tools: ['search_local_files', 'read_local_file', 'find_duplicate_files', 'change_local_files', 'save_spreadsheet_to_folder', 'open_on_device'],
  },
  {
    id: 'social', label: 'Social accounts',
    reads: 'your connected social profiles and posts', does: '', asks: 'posting or replying',
    tools: [],
    prefixes: ['x_', 'linkedin_', 'facebook_', 'instagram_', 'tiktok_'],
  },
  {
    id: 'connectors', label: 'Connected tools (MCP)',
    reads: 'what your connected tools offer', does: 'use them as their settings allow', asks: 'anything they mark as risky',
    tools: [],
    prefixes: ['mcp_'],
  },
];

export const ACCESS_IDS = ACCESS_GROUPS.map((g) => g.id);

/** The tools a routine may use, or undefined for everything (no list saved). */
export function allowedToolsFor(access: string[] | null | undefined): ((name: string) => boolean) | undefined {
  if (!access) return undefined;
  const groups = ACCESS_GROUPS.filter((g) => access.includes(g.id));
  const names = new Set([...BASIC_TOOLS, ...groups.flatMap((g) => g.tools)]);
  const prefixes = groups.flatMap((g) => g.prefixes ?? []);
  return (name) => names.has(name) || prefixes.some((p) => name.startsWith(p));
}

/** A plain summary for the routine card: what it can read, do, and what asks first. */
export function describeAccess(access: string[] | null | undefined) {
  const groups = access ? ACCESS_GROUPS.filter((g) => access.includes(g.id)) : ACCESS_GROUPS;
  const join = (xs: string[]) => xs.filter(Boolean);
  return {
    everything: !access,
    reads: ['your to-dos, notes and saved knowledge', ...join(groups.map((g) => g.reads))],
    does: join(groups.map((g) => g.does)),
    asks: join(groups.map((g) => g.asks)),
  };
}
