// The page's one allow-list worker: snapshots are parsed and their trees built here, off the main thread.
import { snapshotJobs } from "./snapshot-jobs"
import type { JobRequest } from "./snapshot-protocol"

const jobs = snapshotJobs((reply) => postMessage(reply))
addEventListener("message", (e: MessageEvent<JobRequest>) => jobs.handle(e.data))
