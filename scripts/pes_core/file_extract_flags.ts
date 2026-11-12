// SEL-116 — how an isolated extraction ended, as the one shared Int32 the supervisor thread sets and the blocked main thread reads.
// Kept in a file of its own so that neither side has to import the other (the supervisor starts a Worker the moment it is loaded).

export const FLAG_PENDING = 0;
export const FLAG_DONE = 1;
export const FLAG_OUT_OF_MEMORY = 2;
export const FLAG_TIMEOUT = 3;
export const FLAG_ERROR = 4;
