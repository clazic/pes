// SEL-116 — how an isolated extraction ended, as the one shared Int32 the supervisor thread sets and the blocked main thread reads.
// Kept in a file of its own so that neither side has to import the other (the supervisor starts a Worker the moment it is loaded).

export const FLAG_PENDING = 0;
export const FLAG_DONE = 1;
export const FLAG_OUT_OF_MEMORY = 2;
export const FLAG_TIMEOUT = 3;
export const FLAG_ERROR = 4;

// The shared buffer has two Int32 slots. Slot 0 is the outcome (the FLAG_ values above). Slot 1 is set to 1 by the supervisor as the
// very last thing before its thread ends, i.e. "the extraction thread is really gone" — the main thread uses it to tell a thread that
// was cut off at once from one that terminate() could not cut (see file_extract_isolated.ts).
export const SLOT_OUTCOME = 0;
export const SLOT_ENDED = 1;
