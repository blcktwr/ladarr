import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const names = `forgetItemLogsOutsideQueue itemFields queueStatusOf showsSearch titleOf shown label jobEntry jobTitle jobLabel itemJobs indexerWaitOf jobEta lanePositions importOf fileOf view matches templatesOf inLibrary backupAutoHandler importResumeHandler present isActive metadataSweepHandler runningDownloads calendarEvents sharingOf loadingTitleKeys addedByApp clearBlocklist savePush removePush indexersFor upgradeFiles definedResolutions upgradeResolutions manualUpgradeTargets readFolder planFiles planFolder titleBusy presentFile prepare planRename validateNewRoot scanTitle forgetTargets clock summarize filesByTitle libraryFilesRouter attentionKeys libraryFilter libraryFoldersRouter parse libraryPlansRouter dropTitle dropSeason forgetFile verificationOf buildPlan applyExisting targetsOf aliasLanguageOptions parseChanges createBackup setupChecks`.split(/\s+/);
const aliases = ['db', 'pipe.db', 'pipe!.db', 'app.db', 'test.db', 'attached.db', 'missing.db', 'copy'];

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.ts')) files.push(path);
  }
}
walk('packages/server/tests');

for (const file of files) {
  let text = readFileSync(file, 'utf8');
  for (const name of names) {
    for (const alias of aliases) {
      text = text.replaceAll(`${name}(${alias}, `, `${name}(`);
      text = text.replaceAll(`${name}(${alias})`, `${name}()`);
    }
  }
  writeFileSync(file, text);
}
