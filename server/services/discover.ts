/**
 * Discover: ready-made things to ask Carino for. Each card either starts a chat with a prompt,
 * opens a routine idea, opens Ramble, or points to connecting an app. Prompts are written so
 * Carino asks for missing details first instead of guessing.
 */
export interface DiscoverCard {
  id: string;
  category: 'Goals' | 'Plan & organise' | 'Money' | 'Food & health' | 'Family & friends' | 'Home' | 'Work & business' | 'Learn' | 'Out & about' | 'Connected apps';
  icon: string;
  title: string;
  blurb: string;
  action: 'chat' | 'routine' | 'ramble' | 'connect' | 'voice';
  /** Chat prompt, or the routine idea id for action "routine". */
  prompt?: string;
  routine?: string;
  /** Onboarding interests this card suits, for "For you" ordering. */
  interests: string[];
}

const goal = (id: string, area: string, interests: string[], icon = 'target'): DiscoverCard => ({
  id: `goal-${id}`, category: 'Goals', icon, title: `Set a goal: ${area}`,
  blurb: 'Turn a wish into a plan with steps, dates and check-ins.', action: 'chat', interests: ['goals', ...interests],
  prompt: `Help me set a goal for ${area.toLowerCase()}. First ask me two or three short questions about what I want and by when. Then propose one specific, measurable goal, break it into weekly steps, and offer to add the weekly steps as to-dos and a weekly check-in routine.`,
});

export const DISCOVER: DiscoverCard[] = [
  goal('career', 'My career', ['work'], 'briefcase'),
  goal('finances', 'My finances', ['money'], 'chart'),
  goal('savings', 'Saving for something', ['money']),
  goal('health', 'Health & fitness', ['health'], 'heart'),
  goal('kids', 'Kids & school', ['family'], 'book'),
  goal('family', 'Family & care', ['family'], 'heart'),
  goal('friends', 'Friends & plans', ['family'], 'sparkle'),
  goal('travel', 'Travel', ['travel'], 'globe'),
  {
    id: 'weighing', category: 'Plan & organise', icon: 'mic', title: 'What’s weighing on you?', interests: ['organise'],
    blurb: 'Talk it all out — Carino sorts it into to-dos, reminders and things to remember.', action: 'ramble',
  },
  {
    id: 'plan-week', category: 'Plan & organise', icon: 'calendar', title: 'Lighten my week', interests: ['organise', 'work'],
    blurb: 'A realistic plan for the week from your tasks and deadlines.', action: 'chat',
    prompt: 'Look at my tasks, deadlines and reminders for the next 7 days and check my workload. Ask which parts of my week are non-negotiable, then suggest a realistic day-by-day plan and what could move or be dropped. Ask before changing anything.',
  },
  {
    id: 'putting-off', category: 'Plan & organise', icon: 'flag', title: 'The thing I keep putting off',
    blurb: 'Break a dreaded job into a first step small enough to start today.', action: 'chat', interests: ['organise'],
    prompt: 'There is something I keep putting off. Ask me what it is and what makes it hard, then break it into small steps with a first step I can do in under 15 minutes today, and offer to add the steps as tasks.',
  },
  {
    id: 'recurring-charges', category: 'Money', icon: 'chart', title: 'Find subscriptions I don’t use',
    blurb: 'Upload a bank or mobile-money statement; Carino lists the recurring charges.', action: 'chat', interests: ['money'],
    prompt: 'Help me find recurring charges and subscriptions. Ask me to attach a recent bank or mobile-money statement (CSV, Excel or PDF), then list every recurring payment with its yearly cost, flag ones that look unused, and help me make a cancel list. Never cancel anything yourself.',
  },
  {
    id: 'budget', category: 'Money', icon: 'chart', title: 'Make a simple budget',
    blurb: 'A monthly budget from your income and spending, in your currency.', action: 'chat', interests: ['money'],
    prompt: 'Help me make a simple monthly budget. Ask for my income, fixed costs and the currency I use, then suggest a realistic split, savings target and one or two places to cut. Offer to remember the plan and set a monthly reminder to check it.',
  },
  {
    id: 'invoices', category: 'Work & business', icon: 'briefcase', title: 'Chase unpaid invoices',
    blurb: 'Track who owes you and draft polite, firm reminders.', action: 'chat', interests: ['business', 'money'],
    prompt: 'Help me chase unpaid invoices. Ask who owes me what and since when (or look in what you remember), then draft a short, firm and polite reminder for each in my voice, and offer reminders for follow-ups. I will send them myself.',
  },
  {
    id: 'price-watch', category: 'Money', icon: 'target', title: 'Watch a price for me',
    blurb: 'Carino checks daily and tells you when it drops. Never buys.', action: 'routine', routine: 'price-watch', interests: ['money', 'shopping'],
  },
  {
    id: 'meal-plan', category: 'Food & health', icon: 'heart', title: 'Plan my meals this week',
    blurb: 'Simple dinners and one shopping list, based on what you like.', action: 'chat', interests: ['food', 'family'],
    prompt: 'Let\'s plan my meals for this week. Ask how many people, any dietary needs and my budget if you don\'t know them, then plan simple dinners with a combined shopping list grouped by section, and offer to add the shopping list as a to-do.',
  },
  {
    id: 'fridge', category: 'Food & health', icon: 'eye', title: 'What can I cook with this?',
    blurb: 'Snap your fridge or cupboard and get recipe ideas.', action: 'chat', interests: ['food'],
    prompt: 'I want to cook with what I have. I will attach a photo of my fridge or cupboard (or list the ingredients). Suggest three easy recipes, with steps, using mostly what is there.',
  },
  {
    id: 'habit', category: 'Food & health', icon: 'heart', title: 'Build a healthy habit',
    blurb: 'Pick one habit and get a daily nudge that changes each day.', action: 'routine', routine: 'water-walk', interests: ['health'],
  },
  {
    id: 'bedtime', category: 'Family & friends', icon: 'moon', title: 'Tonight’s bedtime story',
    blurb: 'A short story starring your child, new every time.', action: 'chat', interests: ['family'],
    prompt: 'Let\'s write tonight\'s bedtime story starring my kid! Ask for their name, age and two things they love, then write a calm story that takes about three minutes to read aloud.',
  },
  {
    id: 'birthdays', category: 'Family & friends', icon: 'sparkle', title: 'Never miss a birthday',
    blurb: 'Save the dates and budgets; Carino reminds you in time with ideas.', action: 'chat', interests: ['family'],
    prompt: 'Help me keep up with birthdays and occasions. Ask whose birthdays and occasions I never want to miss and a gift budget for each, save them to memory, and set reminders a few days before each.',
  },
  {
    id: 'group', category: 'Family & friends', icon: 'chat', title: 'Carino in your family group',
    blurb: 'Add Carino to a Telegram group to keep plans, lists and dates in one place.', action: 'connect', interests: ['family'],
  },
  {
    id: 'fix-home', category: 'Home', icon: 'settings', title: 'Something at home needs fixing',
    blurb: 'Work out what’s wrong, what it should cost, and who to call.', action: 'chat', interests: ['home'],
    prompt: 'I\'ve got something at home that needs fixing. Ask what is broken, when it started and when I am home, then help me work out the likely cause, whether I can fix it safely myself, a fair price range, and what to say when I call someone. Offer to find nearby repairers and set a reminder.',
  },
  {
    id: 'bin-night', category: 'Home', icon: 'bell', title: 'Remind me of the regular chores',
    blurb: 'Rubbish day, rent, watering plants — recurring reminders in one go.', action: 'chat', interests: ['home', 'organise'],
    prompt: 'Help me set up reminders for my regular chores (rubbish day, rent, bills, watering plants, servicing the car…). Ask which apply and how often, then create recurring tasks with reminders.',
  },
  {
    id: 'customers', category: 'Work & business', icon: 'eye', title: 'See your business as customers do',
    blurb: 'An honest look at your listing, reviews and first impression online.', action: 'chat', interests: ['business'],
    prompt: 'Show me how customers see my business. Ask for my business name and town, search the web for its listings and reviews, and summarise the first impression, common praise and complaints, and three practical improvements.',
  },
  {
    id: 'wins', category: 'Work & business', icon: 'flag', title: 'Log my work wins every Friday',
    blurb: 'A running record of what you achieved — great for reviews.', action: 'routine', routine: 'work-wins', interests: ['work'],
  },
  {
    id: 'meeting-actions', category: 'Work & business', icon: 'tasks', title: 'Meeting notes → actions',
    blurb: 'Paste notes or a transcript; get decisions and action items as to-dos.', action: 'chat', interests: ['work', 'business'],
    prompt: 'I will paste meeting notes or a transcript (or attach the file). Pull out the decisions, the action items with owner and due date, and open questions. Offer to add my action items as to-dos.',
  },
  {
    id: 'formal-letter', category: 'Work & business', icon: 'edit', title: 'Write it in my voice',
    blurb: 'Emails, letters and messages that sound like you.', action: 'chat', interests: ['work'],
    prompt: 'Help me write a message in my own voice. Ask who it is for, what I need to say and the tone, then write a short draft I can edit and send myself.',
  },
  {
    id: 'call-prep', category: 'Plan & organise', icon: 'chat', title: 'Prepare a phone call',
    blurb: 'A short script and the questions to ask, then one tap to dial.', action: 'chat', interests: ['organise', 'business'],
    prompt: 'Help me prepare a phone call. Ask who I am calling, why and what outcome I want, then use prepare_call to write a short script with the key questions and a fallback if they say no.',
  },
  {
    id: 'homework', category: 'Learn', icon: 'book', title: 'Homework helper',
    blurb: 'Explains step by step without just giving the answer.', action: 'chat', interests: ['learn', 'family'],
    prompt: 'Help with homework. Ask for the subject, the level and the question (or a photo of it). Explain step by step and check understanding with a question at each step, without simply giving the final answer.',
  },
  {
    id: 'language', category: 'Learn', icon: 'globe', title: 'Learn a language daily',
    blurb: 'A five-minute lesson each morning, building day by day.', action: 'routine', routine: 'daily-lesson', interests: ['learn'],
  },
  {
    id: 'talk', category: 'Learn', icon: 'speaker', title: 'Just talk it through',
    blurb: 'Hands-free voice conversation — think out loud with Carino.', action: 'voice', interests: ['organise', 'learn'],
  },
  {
    id: 'nearby', category: 'Out & about', icon: 'pin', title: 'Find a place nearby',
    blurb: 'Pharmacies, restaurants, garages — with addresses and a map link.', action: 'chat', interests: ['travel', 'home', 'food'],
    prompt: 'Find a place near me. Ask what I am looking for and where I am (or use my shared location), then use find_places and list the best options with address and a map link.',
  },
  {
    id: 'trip', category: 'Out & about', icon: 'globe', title: 'Plan a trip',
    blurb: 'Route, budget, packing list and a day-by-day plan.', action: 'chat', interests: ['travel'],
    prompt: 'Help me plan a trip. Ask where, when, who is coming and my budget, then suggest how to get there, where to stay, a simple day-by-day plan and a packing list. Offer to add the bookings and packing as to-dos with reminders.',
  },
  {
    id: 'email', category: 'Connected apps', icon: 'send', title: 'Emails needing my reply',
    blurb: 'Connect your email and Carino lists what is waiting on you each morning.', action: 'routine', routine: 'email-triage', interests: ['work'],
  },
  {
    id: 'connect', category: 'Connected apps', icon: 'link', title: 'Connect your apps',
    blurb: 'Email, calendar, chat and more — Carino gets sharper with each one.', action: 'connect', interests: ['work', 'business'],
  },
];
