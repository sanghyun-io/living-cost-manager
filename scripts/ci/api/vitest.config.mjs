// The fixture orchestrator also exercises a failed real restore. Keep it
// sequential with the successful PG16 proof: at most ONE owned postmaster.
export default {test:{fileParallelism:false}};
