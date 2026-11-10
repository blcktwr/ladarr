import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const objectNames = ['librarySearchHandler', 'libraryScanHandler', 'metadataRefreshHandler', 'libraryVerifyHandler', 'queueInitialHandler', 'queueGrabHandler', 'importRunHandler', 'migrationImportHandler', 'webhookDeliverHandler', 'verifySweepHandler', 'jobHandlers'];
const simpleNames = ['importResumeHandler', 'backupAutoHandler', 'createBackup', 'scanTitle', 'requestVerification', 'libraryFilesRouter', 'libraryPlansRouter', 'libraryFoldersRouter', 'filesByTitle', 'summarize', 'validateNewRoot', 'calendarEvents', 'upgradeResolutions', 'manualUpgradeTargets', 'itemFields', 'planRename', 'prepare', 'readFolder', 'planFiles', 'planFolder', 'dropTitle', 'dropSeason', 'forgetFile', 'verificationOf', 'titleBusy', 'presentFile', 'inLibrary', 'sharingOf', 'loadingTitleKeys', 'addedByApp', 'clearBlocklist', 'savePush', 'removePush', 'indexersFor', 'upgradeFiles', 'definedResolutions', 'forgetTargets', 'libraryFilter'];
const aliases = ['db', 'pipe.db', 'pipe!.db', 'app.db', 'test.db', 'attached.db', 'missing.db', 't.pipe.db', 't.pipe!.db', 't.db', 'copy'];

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
  for (const name of objectNames) {
    text = text.replaceAll(`${name}({ db, `, `${name}({ `);
    for (const alias of aliases) text = text.replaceAll(`${name}({ db: ${alias}, `, `${name}({ `);
    text = text.replace(new RegExp(`${name}\\(\\{\\s*db,\\s*`, 'g'), `${name}({ `);
  }
  for (const name of simpleNames) {
    for (const alias of aliases) {
      text = text.replaceAll(`${name}(${alias}, `, `${name}(`);
      text = text.replaceAll(`${name}(${alias})`, `${name}()`);
    }
  }
  writeFileSync(file, text);
}
