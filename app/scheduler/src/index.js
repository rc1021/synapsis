const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const log = require('./logger');
const { runJob, getRunningJobs } = require('./job-runner');
const { UserJobScheduler } = require('./user-job-scheduler');

const JOBS_FILE = path.join(__dirname, '..', 'jobs.json');

let scheduledTasks = []; // { jobId, task }
let shuttingDown = false;
let userJobScheduler;

function loadJobs() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return data.jobs || [];
  } catch (err) {
    log.error('Failed to load jobs.json:', err.message);
    return [];
  }
}

function scheduleJobs(jobs) {
  for (const { jobId, task } of scheduledTasks) {
    task.stop();
    log.info(`Unscheduled: ${jobId}`);
  }
  scheduledTasks = [];

  for (const job of jobs) {
    if (!job.enabled) {
      log.info(`Skipping disabled job: ${job.id}`);
      continue;
    }

    if (!cron.validate(job.schedule)) {
      log.error(`Invalid cron expression for ${job.id}: ${job.schedule}`);
      continue;
    }

    const task = cron.schedule(job.schedule, () => {
      if (shuttingDown) return;
      runJob(job).then(() => {
        if (job.once) disableJob(job.id);
      }).catch(err => {
        log.error(`Unhandled error in job ${job.id}:`, err.message);
      });
    });

    scheduledTasks.push({ jobId: job.id, task });
    log.info(`Scheduled: ${job.id} [${job.schedule}]`);
  }
}

function disableJob(jobId) {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const job = data.jobs.find(j => j.id === jobId);
    if (job) {
      job.enabled = false;
      fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2) + '\n');
      log.info(`One-time job ${jobId} disabled`);
    }
  } catch (err) {
    log.error(`Failed to disable job ${jobId}:`, err.message);
  }
}

function watchJobsFile() {
  let debounce = null;
  fs.watchFile(JOBS_FILE, { interval: 5000 }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      log.info('jobs.json changed, reloading...');
      const jobs = loadJobs();
      scheduleJobs(jobs);
    }, 1000);
  });
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Scheduler shutting down...');

  for (const { task } of scheduledTasks) {
    task.stop();
  }

  if (userJobScheduler) {
    userJobScheduler.stop();
  }

  const maxWait = 30000;
  const start = Date.now();
  while (getRunningJobs().length > 0 && Date.now() - start < maxWait) {
    const running = getRunningJobs();
    log.info(`Waiting for ${running.length} running job(s): ${running.join(', ')}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (getRunningJobs().length > 0) {
    log.warn(`Force exit with ${getRunningJobs().length} jobs still running`);
  }

  fs.unwatchFile(JOBS_FILE);
  log.info('Scheduler stopped');
}

function start() {
  log.info('Scheduler starting...');

  // System-level jobs
  const jobs = loadJobs();
  if (jobs.length === 0) {
    log.warn('No system jobs found in jobs.json');
  }
  scheduleJobs(jobs);
  watchJobsFile();

  // User-level job scheduler
  userJobScheduler = new UserJobScheduler();
  userJobScheduler.start();

  log.info(`Scheduler running with ${scheduledTasks.length} system job(s)`);
}

module.exports = { name: 'scheduler', start, cleanup };
