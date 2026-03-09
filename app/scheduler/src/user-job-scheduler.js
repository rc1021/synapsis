const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cron = require('node-cron');
const log = require('./logger');
const { runUserJob } = require('./job-runner');
const wm = require('../../bridges/shared/workspace-manager');

const engagement = require('../../bridges/shared/engagement');
const { notifyAllBindings } = require('./notifier');
const { getPendingMigrations } = require('../migrations/runner');

const JOB_QUEUE_DIR = path.join(__dirname, '..', 'job-queue');
const COMMON_JOBS_FILE = path.join(__dirname, '..', 'common-jobs.json');
const PREFERENCES_BOUNDS_FILE = path.join(__dirname, '..', 'preferences-bounds.json');
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'workspace-template');
const CURRENT_TEMPLATE_VERSION = require('../../package.json').version;
const MAX_USER_JOBS = 500;
const TICK_INTERVAL = 60 * 1000; // 60 seconds
const EVENT_SCAN_INTERVAL = 10; // scan every N ticks (10 min)
const TALK_HISTORY_FILE = 'talk-history.jsonl';
const MARKERS_DIR = path.join(__dirname, '..', 'markers');
const EVENT_COOLDOWN_HOURS = 4; // min hours between any two event jobs per workspace
const NON_COOLDOWN_MIN_HOURS = 4; // min hours between repeated non-cooldown event jobs (talk-history, callback, spaced-review)
const ONBOARDING_INTERVAL_DAYS = 2; // don't nag more than once per N days
const USER_MD_FILE = 'USER.md';
const NOT_SET_MARKER = '_(not set)_';
const PREFERENCES_FILE = 'preferences.json';
const PENDING_CALLBACKS_FILE = 'pending-callbacks.json';

class UserJobScheduler {
  constructor() {
    this.tickTimer = null;
    this.lastScanTime = 0;
    this.tickCount = 0;
    const loaded = this._loadCommonJobs();
    this.eventJobs = loaded.eventJobs;
    this.onboardingJob = loaded.onboardingJob;
    this.featureIntroJob = loaded.featureIntroJob;
    this._preferencesBounds = this._loadPreferencesBounds();
  }

  _loadCommonJobs() {
    try {
      const raw = fs.readFileSync(COMMON_JOBS_FILE, 'utf-8');
      const data = JSON.parse(raw);

      const onboardingJob = data.onboardingJob || null;
      const featureIntroJob = data.featureIntroJob || null;
      const jobs = data.eventJobs || [];

      // Pre-resolve specFile content
      for (const job of jobs) {
        if (job.specFile) {
          const specPath = path.join(path.dirname(COMMON_JOBS_FILE), job.specFile);
          try {
            job._specContent = fs.readFileSync(specPath, 'utf-8');
          } catch (err) {
            log.warn(`Failed to read specFile for event job ${job.id}: ${err.message}`);
          }
        }
      }

      log.info(`Loaded ${jobs.length} event job(s)${onboardingJob ? ' + onboarding' : ''}${featureIntroJob ? ' + feature-intro' : ''}`);
      return { eventJobs: jobs, onboardingJob, featureIntroJob };
    } catch (err) {
      log.warn(`Failed to load common-jobs.json: ${err.message}`);
      return { eventJobs: [], onboardingJob: null, featureIntroJob: null };
    }
  }

  _loadPreferencesBounds() {
    try {
      return JSON.parse(fs.readFileSync(PREFERENCES_BOUNDS_FILE, 'utf-8'));
    } catch (err) {
      log.warn(`Failed to load preferences-bounds.json: ${err.message}`);
      return {};
    }
  }

  /**
   * Read workspace preferences.json and return override value for a given key.
   * Key format: "jobId.param" (e.g., "seedWatering.minLines")
   * Returns the overridden value if valid (within bounds), or defaultVal.
   */
  _getPreference(wsDir, key, defaultVal) {
    try {
      const prefsPath = path.join(wsDir, PREFERENCES_FILE);
      if (!fs.existsSync(prefsPath)) return defaultVal;

      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
      const [section, param] = key.split('.');
      const val = prefs[section] && prefs[section][param];
      if (val === undefined || val === null) return defaultVal;

      // Enforce bounds
      const bounds = this._preferencesBounds[key];
      if (bounds) {
        if (bounds.type === 'boolean') return !!val;
        if (typeof val === 'number') {
          if (bounds.min !== undefined && val < bounds.min) return bounds.min;
          if (bounds.max !== undefined && val > bounds.max) return bounds.max;
        }
      }

      return val;
    } catch {
      return defaultVal;
    }
  }

  // --- Workspace migration ---

  /**
   * Check all workspaces and migrate those on older template versions.
   * Runs once at startup.
   */
  async _migrateWorkspaces() {
    const wsDirs = this._getAllWorkspaceDirs();
    for (const { wsId, wsDir } of wsDirs) {
      try {
        const profile = wm.readProfile(wsDir);
        if (!profile) continue;

        const currentVersion = profile.templateVersion || '1.0.0';
        const pending = getPendingMigrations(currentVersion);
        if (!pending.length) continue;

        const ctx = {
          wsId, wsDir, profile, log, wm,
          templateDir: TEMPLATE_DIR,
          notifyAllBindings,
        };

        for (const { version, migrate } of pending) {
          log.info(`Workspace ${wsId}: running migration ${version}`);
          await migrate(ctx);
        }

        profile.templateVersion = CURRENT_TEMPLATE_VERSION;
        wm.writeProfile(wsDir, profile);
        log.info(`Workspace ${wsId} migrated to v${CURRENT_TEMPLATE_VERSION}`);
      } catch (err) {
        log.error(`Migration failed for ${wsId}: ${err.message}`);
      }
    }
  }

  start() {
    // Run workspace migrations before starting
    this._migrateWorkspaces().catch(err => {
      log.error(`Workspace migration error: ${err.message}`);
    });

    // Initial scan: build time buckets for all user jobs
    this._rebuildAllBuckets();
    this.lastScanTime = Date.now();

    // Start tick timer
    this.tickTimer = setInterval(() => this._tick(), TICK_INTERVAL);

    log.info('User job scheduler started');
  }

  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    log.info('User job scheduler stopped');
  }

  /**
   * Scan for recently modified jobs.json files and rebuild their buckets.
   */
  _scanChangedJobs() {
    try {
      const result = execSync(
        `find "${wm.DATA_DIR}" -mindepth 6 -maxdepth 6 -name "jobs.json" -type f -mmin -2 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      if (!result) return;

      for (const filePath of result.split('\n').filter(Boolean)) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs <= this.lastScanTime) continue;

        const wsDir = path.dirname(filePath);
        const wsId = path.basename(wsDir);
        log.info(`User jobs.json changed: ${wsId}`);
        this._rebuildBucketsForWorkspace(wsId, wsDir);
      }

      this.lastScanTime = Date.now();
    } catch (err) {
      if (err.status !== 1) {
        log.warn(`Failed to scan changed jobs: ${err.message}`);
      }
    }
  }

  /**
   * Scan all workspaces, rebuild time buckets.
   */
  _rebuildAllBuckets() {
    this._clearFutureBuckets();

    try {
      const result = execSync(
        `find "${wm.DATA_DIR}" -mindepth 6 -maxdepth 6 -name "jobs.json" -type f 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000 }
      ).trim();

      if (!result) return;

      const files = result.split('\n').filter(Boolean);
      let totalJobs = 0;

      for (const filePath of files) {
        const wsDir = path.dirname(filePath);
        const wsId = path.basename(wsDir);
        const jobs = this._loadUserJobs(filePath);
        totalJobs += jobs.length;
        this._registerJobs(wsId, jobs);
      }

      log.info(`Rebuilt time buckets: ${files.length} workspaces, ${totalJobs} jobs`);
    } catch (err) {
      if (err.status !== 1) {
        log.warn(`Failed to scan user jobs: ${err.message}`);
      }
    }
  }

  _rebuildBucketsForWorkspace(wsId, wsAbsPath) {
    this._removeBucketsForWorkspace(wsId);

    const jobsPath = path.join(wsAbsPath, 'jobs.json');
    const jobs = this._loadUserJobs(jobsPath);
    this._registerJobs(wsId, jobs);

    log.info(`Rebuilt buckets for ${wsId}: ${jobs.length} jobs`);
  }

  _loadUserJobs(jobsPath) {
    try {
      const raw = fs.readFileSync(jobsPath, 'utf-8');
      const data = JSON.parse(raw);
      return (data.jobs || [])
        .filter(j => j.enabled !== false)
        .slice(0, MAX_USER_JOBS);
    } catch {
      return [];
    }
  }

  _registerJobs(wsId, jobs) {
    for (const job of jobs) {
      if (!job.schedule || !cron.validate(job.schedule)) {
        log.warn(`User job ${job.id} (${wsId}): invalid schedule "${job.schedule}"`);
        continue;
      }

      const nextTime = this._getNextCronTime(job.schedule);
      if (!nextTime) continue;

      this._writeToBucket(nextTime, wsId, job.id, job.priority || 'normal');
    }
  }

  _getNextCronTime(schedule) {
    try {
      const now = new Date();

      for (let i = 1; i <= 1440; i++) {
        const candidate = new Date(now.getTime() + i * 60000);
        candidate.setSeconds(0, 0);

        if (this._matchesCron(schedule, candidate)) {
          return candidate;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  _matchesCron(schedule, date) {
    const parts = schedule.split(/\s+/);
    if (parts.length < 5) return false;

    const [minP, hourP, domP, monP, dowP] = parts;

    return this._matchField(minP, date.getMinutes(), 0, 59) &&
           this._matchField(hourP, date.getHours(), 0, 23) &&
           this._matchField(domP, date.getDate(), 1, 31) &&
           this._matchField(monP, date.getMonth() + 1, 1, 12) &&
           this._matchField(dowP, date.getDay(), 0, 6);
  }

  _matchField(pattern, value, min, max) {
    if (pattern === '*') return true;

    if (pattern.startsWith('*/')) {
      const step = parseInt(pattern.slice(2));
      return value % step === 0;
    }

    const values = pattern.split(',');
    for (const v of values) {
      if (v.includes('-')) {
        const [lo, hi] = v.split('-').map(Number);
        if (value >= lo && value <= hi) return true;
      } else {
        if (parseInt(v) === value) return true;
      }
    }
    return false;
  }

  _bucketKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${d}_${h}-${min}`;
  }

  _writeToBucket(date, wsId, jobId, priority) {
    const bucketDir = path.join(JOB_QUEUE_DIR, this._bucketKey(date));
    const shard1 = wsId.slice(0, 2);
    const shard2 = wsId.slice(2, 4);
    const shardDir = path.join(bucketDir, shard1);
    const shardFile = path.join(shardDir, `${shard2}.jsonl`);

    fs.mkdirSync(shardDir, { recursive: true });

    const entry = JSON.stringify({ w: wsId, j: jobId, p: priority }) + '\n';
    fs.appendFileSync(shardFile, entry);
  }

  _clearFutureBuckets() {
    try {
      if (fs.existsSync(JOB_QUEUE_DIR)) {
        const entries = fs.readdirSync(JOB_QUEUE_DIR);
        for (const entry of entries) {
          const fullPath = path.join(JOB_QUEUE_DIR, entry);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      log.warn(`Failed to clear future buckets: ${err.message}`);
    }
  }

  _removeBucketsForWorkspace(wsId) {
    // No-op: _processEntry re-reads jobs.json at execution time,
    // deleted jobs are skipped naturally. Dedup handles repeated entries.
  }

  // --- Onboarding check ---

  /**
   * Check if a workspace still needs onboarding (USER.md has blank fields).
   */
  _needsOnboarding(wsDir) {
    try {
      const userMd = fs.readFileSync(path.join(wsDir, USER_MD_FILE), 'utf-8');
      return userMd.includes(NOT_SET_MARKER);
    } catch {
      return false; // no USER.md = skip
    }
  }

  // --- Event triggers ---

  /**
   * Scan all event triggers across workspaces.
   * Per-workspace cooldown ensures at most one event job fires per cooldown window.
   * If user hasn't completed onboarding, run onboarding prompt instead.
   */
  async _scanEventTriggers() {
    if (!this.eventJobs.length && !this.onboardingJob) return;

    const wsDirs = this._getAllWorkspaceDirs();
    if (!wsDirs.length) return;

    const COOLDOWN_TYPES = new Set(['proactive', 'idle-checkin', 'discovery']);

    for (const { wsId, wsDir } of wsDirs) {
      const cooldownMarker = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId), '.last-event');
      const onCooldown = this._markerTooRecent(cooldownMarker, EVENT_COOLDOWN_HOURS / 24);

      // Onboarding guard: if USER.md still has blanks, run onboarding instead of event jobs
      if (this.onboardingJob && this._needsOnboarding(wsDir)) {
        if (onCooldown) continue;
        const onboardingMarker = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId), '.last-onboarding');
        if (this._markerTooRecent(onboardingMarker, ONBOARDING_INTERVAL_DAYS)) continue;

        try {
          log.info(`Onboarding needed for ${wsId}, running onboarding prompt`);
          await this._runEventJob(this.onboardingJob, wsId, wsDir);
          // Write onboarding-specific marker
          const markerDir = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId));
          fs.mkdirSync(markerDir, { recursive: true });
          fs.writeFileSync(path.join(markerDir, '.last-onboarding'), new Date().toISOString());
        } catch (err) {
          log.error(`Onboarding failed for ${wsId}: ${err.message}`);
        }
        continue; // skip normal event jobs for this workspace
      }

      // Feature intro: one-time, runs after onboarding is done and workspace is ≥ 2 days old
      if (this.featureIntroJob) {
        const introMarker = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId), '.last-feature-intro');
        if (!fs.existsSync(introMarker) && !onCooldown) {
          // Check workspace age ≥ 2 days (use profile createdAt or talk-history mtime)
          const profile = wm.readProfile(wsDir);
          const createdAt = profile?.createdAt ? new Date(profile.createdAt).getTime() : 0;
          const ageMs = createdAt ? Date.now() - createdAt : Infinity;
          const FEATURE_INTRO_DELAY_DAYS = 2;

          if (ageMs >= FEATURE_INTRO_DELAY_DAYS * 86400000) {
            try {
              log.info(`Feature intro for ${wsId}`);
              await this._runEventJob(this.featureIntroJob, wsId, wsDir);
            } catch (err) {
              log.error(`Feature intro failed for ${wsId}: ${err.message}`);
            }
            continue; // skip normal event jobs this cycle
          }
        }
      }

      for (const job of this.eventJobs) {
        const type = job.trigger?.type;
        if (!type) continue;
        if (onCooldown && COOLDOWN_TYPES.has(type)) continue;
        if (job.requires && !fs.existsSync(path.join(wsDir, job.requires))) continue;

        try {
          if (!this._checkTrigger(job, wsDir)) continue;

          log.info(`Event trigger [${type}] fired for ${wsId}, running ${job.id}`);
          await this._runEventJob(job, wsId, wsDir);
          if (COOLDOWN_TYPES.has(type)) break; // one cooldown job per workspace per scan
        } catch (err) {
          log.error(`Event job ${job.id} failed for ${wsId}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Check if a trigger condition is met for a workspace.
   */
  _checkTrigger(job, wsDir) {
    const type = job.trigger.type;
    const wsId = path.basename(wsDir);
    const markerFile = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId), `.last-${job.id}`);
    const talkHistoryPath = path.join(wsDir, TALK_HISTORY_FILE);

    // Preference key mapping for per-workspace overrides
    const PREF_MAP = {
      'seed-watering': 'seedWatering',
      'proactive': 'proactive',
      'idle-checkin': 'idleCheckin',
      'discovery': 'discovery',
      'challenge': 'challenge',
      'weekly-synthesis': 'weeklySynthesis',
      'reflection-prompt': 'reflectionPrompt',
      'memory-consolidation': 'memoryConsolidation',
    };
    const prefSection = PREF_MAP[job.id];

    switch (type) {
      case 'talk-history': {
        // Guard: don't re-trigger if this job ran recently
        if (this._markerTooRecent(markerFile, NON_COOLDOWN_MIN_HOURS / 24)) return false;
        const defaultMinLines = job.trigger.minLines || 30;
        const minLines = prefSection
          ? this._getPreference(wsDir, `${prefSection}.minLines`, defaultMinLines)
          : defaultMinLines;
        if (!fs.existsSync(talkHistoryPath)) return false;
        const lineCount = parseInt(
          execSync(`wc -l < "${talkHistoryPath}"`, { encoding: 'utf-8', timeout: 5000 }).trim(), 10
        );
        return lineCount >= minLines;
      }

      case 'proactive': {
        const defaultInterval = job.trigger.intervalDays || 1;
        const intervalDays = prefSection
          ? this._getPreference(wsDir, `${prefSection}.intervalDays`, defaultInterval)
          : defaultInterval;
        const activeDays = job.trigger.activeDays || 7;
        // Skip if marker is too recent
        if (this._markerTooRecent(markerFile, intervalDays)) return false;
        // Only if user has been active within activeDays
        return this._userActiveWithin(talkHistoryPath, activeDays);
      }

      case 'idle-checkin': {
        const defaultIdle = job.trigger.idleDays || 3;
        const idleDays = prefSection
          ? this._getPreference(wsDir, `${prefSection}.idleDays`, defaultIdle)
          : defaultIdle;
        // Skip if marker is too recent (don't nag)
        if (this._markerTooRecent(markerFile, idleDays)) return false;
        // Trigger if user HAS a talk-history (not brand new) but hasn't chatted in idleDays
        if (!fs.existsSync(talkHistoryPath)) return false;
        return !this._userActiveWithin(talkHistoryPath, idleDays);
      }

      case 'discovery': {
        const defaultInterval = job.trigger.intervalDays || 5;
        const intervalDays = prefSection
          ? this._getPreference(wsDir, `${prefSection}.intervalDays`, defaultInterval)
          : defaultInterval;
        // Skip if marker is too recent
        if (this._markerTooRecent(markerFile, intervalDays)) return false;
        // Trigger if talk-history exists (user has used the bot before)
        return fs.existsSync(talkHistoryPath);
      }

      case 'callback': {
        // Guard: don't re-trigger if this job ran recently
        if (this._markerTooRecent(markerFile, NON_COOLDOWN_MIN_HOURS / 24)) return false;
        // Trigger if pending-callbacks.json has items whose targetDate <= today
        try {
          const cbPath = path.join(wsDir, PENDING_CALLBACKS_FILE);
          if (!fs.existsSync(cbPath)) return false;
          const callbacks = JSON.parse(fs.readFileSync(cbPath, 'utf-8'));
          const today = new Date().toISOString().slice(0, 10);
          return callbacks.some(cb => !cb.followedUp && cb.targetDate <= today);
        } catch {
          return false;
        }
      }

      case 'spaced-review': {
        // Guard: don't re-trigger if this job ran recently
        if (this._markerTooRecent(markerFile, NON_COOLDOWN_MIN_HOURS / 24)) return false;
        // Trigger if any learning notes are due for review
        try {
          const learningDir = path.join(wsDir, 'memory', 'learning');
          if (!fs.existsSync(learningDir)) return false;
          // Check for notes that need review at day 2, 7, 30
          const result = execSync(
            `find "${learningDir}" -name "*.md" -type f 2>/dev/null | head -50`,
            { encoding: 'utf-8', timeout: 10000 }
          ).trim();
          if (!result) return false;
          const reviewIntervals = [2, 7, 30]; // days
          const now = Date.now();
          const markerDir = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId));
          const dueNotes = [];
          for (const filePath of result.split('\n').filter(Boolean)) {
            const stat = fs.statSync(filePath);
            const ageDays = (now - stat.birthtimeMs) / 86400000;
            for (const interval of reviewIntervals) {
              if (ageDays >= interval && ageDays < interval + 2) {
                const noteId = path.basename(filePath, '.md');
                const reviewMarker = path.join(markerDir, `.reviewed-${noteId}-d${interval}`);
                if (!fs.existsSync(reviewMarker)) {
                  dueNotes.push({ noteId, interval, markerDir });
                }
              }
            }
          }
          if (dueNotes.length === 0) return false;
          // Write per-note review markers upfront to prevent re-triggering
          fs.mkdirSync(dueNotes[0].markerDir, { recursive: true });
          for (const { noteId, interval, markerDir: md } of dueNotes) {
            const reviewMarker = path.join(md, `.reviewed-${noteId}-d${interval}`);
            fs.writeFileSync(reviewMarker, new Date().toISOString());
          }
          return true;
        } catch {
          return false;
        }
      }

      default:
        return false;
    }
  }

  /**
   * Check if a marker file exists and is newer than N days.
   */
  _markerTooRecent(markerFile, days) {
    try {
      if (!fs.existsSync(markerFile)) return false;
      const stat = fs.statSync(markerFile);
      return (Date.now() - stat.mtimeMs) < days * 86400000;
    } catch {
      return false;
    }
  }

  /**
   * Check if user has chatted within the last N days (by talk-history mtime).
   */
  _userActiveWithin(talkHistoryPath, days) {
    try {
      if (!fs.existsSync(talkHistoryPath)) return false;
      const stat = fs.statSync(talkHistoryPath);
      return (Date.now() - stat.mtimeMs) < days * 86400000;
    } catch {
      return false;
    }
  }

  /**
   * Run an event job in a workspace context.
   */
  async _runEventJob(job, wsId, wsAbsPath) {
    const talkHistoryPath = path.join(wsAbsPath, TALK_HISTORY_FILE);
    const markerDir = path.join(MARKERS_DIR, wm.workspaceRelPath(wsId));
    const markerFile = path.join(markerDir, `.last-${job.id}`);

    // Read talk-history if it exists
    let talkHistory = '';
    if (fs.existsSync(talkHistoryPath)) {
      talkHistory = fs.readFileSync(talkHistoryPath, 'utf-8');
    }

    // Inject notify so runUserJob sends the result to the user
    // Use not_match to suppress known skip outputs
    const jobWithContext = {
      ...job,
      _talkHistory: talkHistory,
      notify: { when: 'not_match', match: '_SKIP' },
    };

    await runUserJob(jobWithContext, wsId, wsAbsPath);

    // Write per-job marker to prevent re-triggering
    fs.mkdirSync(markerDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(markerFile, now);

    // Write cooldown marker for proactive/idle/discovery (not talk-history)
    // Write cooldown marker (onboarding also counts as an event for cooldown purposes)
    const triggerType = job.trigger?.type;
    const COOLDOWN_TYPES = new Set(['proactive', 'idle-checkin', 'discovery']);
    if (!triggerType || COOLDOWN_TYPES.has(triggerType)) {
      fs.writeFileSync(path.join(markerDir, '.last-event'), now);
    }

    // Archive talk-history only for jobs that explicitly opt in
    if (job.archiveTalkHistory && fs.existsSync(talkHistoryPath)) {
      const archiveDir = path.join(wsAbsPath, 'talk-history-archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.renameSync(talkHistoryPath, path.join(archiveDir, `${ts}.jsonl`));
      log.info(`Talk-history archived for ${wsId}`);
    }
  }

  _getAllWorkspaceDirs() {
    try {
      const result = execSync(
        `find "${wm.DATA_DIR}" -mindepth 5 -maxdepth 5 -type d 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000 }
      ).trim();

      if (!result) return [];

      return result.split('\n').filter(Boolean).map(wsDir => ({
        wsId: path.basename(wsDir),
        wsDir,
      }));
    } catch (err) {
      if (err.status !== 1) {
        log.warn(`Failed to scan workspace dirs: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * Main tick: scan for changed jobs, process current minute's bucket, check event triggers.
   */
  async _tick() {
    this.tickCount++;

    // Phase 1: detect changed jobs.json via mtime
    this._scanChangedJobs();

    // Phase 2: process current minute's bucket
    const now = new Date();
    now.setSeconds(0, 0);
    const key = this._bucketKey(now);
    const bucketDir = path.join(JOB_QUEUE_DIR, key);

    if (fs.existsSync(bucketDir)) {
      try {
        const result = execSync(
          `find "${bucketDir}" -mindepth 2 -maxdepth 2 -type f -name "*.jsonl" 2>/dev/null`,
          { encoding: 'utf-8', timeout: 10000 }
        ).trim();

        if (!result) {
          this._cleanupBucket(bucketDir);
        } else {
          const shardFiles = result.split('\n').filter(Boolean);
          const entries = [];

          for (const file of shardFiles) {
            try {
              const content = fs.readFileSync(file, 'utf-8');
              for (const line of content.split('\n')) {
                if (!line.trim()) continue;
                try {
                  const entry = JSON.parse(line);
                  entries.push(entry);
                } catch {
                  log.warn(`Invalid JSONL line in ${file}: ${line.slice(0, 100)}`);
                }
              }
            } catch (err) {
              log.warn(`Failed to read shard ${file}: ${err.message}`);
            }
          }

          if (entries.length > 0) {
            const priorityOrder = { high: 0, normal: 1, low: 2 };
            entries.sort((a, b) => (priorityOrder[a.p] || 1) - (priorityOrder[b.p] || 1));

            const seen = new Set();
            const unique = entries.filter(e => {
              const key2 = `${e.w}:${e.j}`;
              if (seen.has(key2)) return false;
              seen.add(key2);
              return true;
            });

            log.info(`Tick ${key}: ${unique.length} user job(s) to process (${entries.length - unique.length} duplicates removed)`);

            for (const entry of unique) {
              await this._processEntry(entry);
            }
          }

          this._cleanupBucket(bucketDir);
        }
      } catch (err) {
        if (err.status !== 1) {
          log.warn(`Tick error for ${key}: ${err.message}`);
        }
      }
    }

    // Phase 3: scan event triggers (every N ticks)
    if (this.tickCount % EVENT_SCAN_INTERVAL === 0) {
      await this._scanEventTriggers();

      // Expire old engagement pending entries + cleanup stale BOOTSTRAP.md
      try {
        const wsDirs = this._getAllWorkspaceDirs();
        for (const { wsDir } of wsDirs) {
          engagement.expirePending(wsDir);

          // Clean up BOOTSTRAP.md if onboarding is already done
          const bootstrapPath = path.join(wsDir, 'BOOTSTRAP.md');
          if (fs.existsSync(bootstrapPath) && !this._needsOnboarding(wsDir)) {
            fs.unlinkSync(bootstrapPath);
            log.info(`Cleaned up stale BOOTSTRAP.md in ${path.basename(wsDir)}`);
          }
        }
      } catch (err) {
        log.debug(`Engagement expiry error: ${err.message}`);
      }
    }
  }

  async _processEntry(entry) {
    const { w: wsId, j: jobId } = entry;
    const wsAbsPath = wm.workspaceAbsPath(wsId);

    if (!fs.existsSync(wsAbsPath)) {
      log.warn(`Workspace not found for job ${jobId}: ${wsId}`);
      return;
    }

    const jobsPath = path.join(wsAbsPath, 'jobs.json');
    let job;
    try {
      const data = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
      job = (data.jobs || []).find(j => j.id === jobId);
    } catch {
      return;
    }

    if (!job || job.enabled === false) return;

    try {
      await runUserJob(job, wsId, wsAbsPath);
    } catch (err) {
      log.error(`User job ${jobId} (${wsId}) failed: ${err.message}`);
    }

    const nextTime = this._getNextCronTime(job.schedule);
    if (nextTime) {
      this._writeToBucket(nextTime, wsId, jobId, job.priority || 'normal');
    }
  }

  _cleanupBucket(bucketDir) {
    try {
      fs.rmSync(bucketDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`Failed to cleanup bucket ${bucketDir}: ${err.message}`);
    }
  }
}

module.exports = { UserJobScheduler };
