# Dharma of this repository

The duty this repository holds, and the conduct expected of anyone, person or agent, who changes it.

## Its duty

To let a person drive a vehicle over measured or generated ground and come away with a true answer: can a vehicle get
there, what does the ground do to it, and what will a client see on the way. Driving is the interface; the answer is
the point.

## Conduct

1. **Say what the numbers show.** Every figure is either measured, cited by standard number, or labelled as assumed.
   A failing check is reported as failing. Agreement between two methods we wrote shows they are consistent, not that
   they are true; say which it is.
2. **Keep the means clean.** Respect licences and data terms. Cite standards by number; never copy their text.
   Nothing private, no names of projects, sites, clients, people or brands, and no local paths, in any file here.
3. **Expose faults, not people.** A check that fails on a design is there to help put it right.
4. **Use only what the task needs.** The web engine does no work while the vehicle is parked. GPU runs are taken under
   a lock and released. No brute force where a smaller method answers the question.
5. **Duty with judgement.** Finish the job that was asked, fully and tested. If a change would publish something
   private or break a rule above, stop and say so instead.
6. **Read before writing.** Reuse what the federation already has (the cartridge and plug schema, the world's ground,
   the pair method) rather than building a second copy.
7. **Let the result stand.** Receipts record the engine, the inputs' digest and the verdict. Do not tune a threshold
   to make a run pass.
8. **Leave it tidy.** Tests pass, receipts are LF with sha256, and the next person can run everything from the README.

## The pair method

Every Python cartridge is checked the same way: two independent formulations (the electron and the positron) run the
same inputs; their disagreements (photons) are counted and located; a CPU witness re-runs a sample on NumPy; and the
run writes an LF receipt with a sha256 digest, recording which engine (`BUGGY_ENGINE=cupy|numpy`) actually ran.
