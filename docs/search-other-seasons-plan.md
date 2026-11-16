# Search other seasons

Status: plan. Date: 2026-11-15.

## 1. Goal

A release does not always follow the season numbering of TMDB. One release can put in season 1 what TMDB puts in the first ten episodes of season 1, and put the other ten in season 2. The queued target that the pack does not hold must still find its file.

The fix is a manual action on a stuck target: **Search other seasons**. The user starts it from the card of the season. It searches the episodes that are still missing under another season of the releases, and it maps those files back to the episodes of TMDB.

Example:

```text
TMDB:
  S1 -> episodes 1-20

Releases:
  S1 -> episodes 1-10
  S2 -> episodes 1-10

Mapping:
  release S1E01-E10 -> TMDB S1E01-E10
  release S2E01-E10 -> TMDB S1E11-E20
```

The numbering of TMDB stays the identity of the target. The numbering of the release only selects files and maps them.

The button starts one search run. When a run finds a release and a valid mapping, the target continues through the normal download and import flow.

## 2. Behavior

### When a pack is partial

1. Read the files that the pack really holds.
2. Continue the targets that the pack covers.
3. Leave the others in `stuck`, with the reason.
4. Show **Search other seasons** on the card of the season.
5. Wait for the user.

A partial pack does not start the other-season search by itself.

### When the user starts the action

1. Read the targets that are still missing in that TMDB season.
2. Read the numbering of the releases that the app knows.
3. Search other seasons of the releases.
4. Read which files of a release fit the missing targets.
5. Continue only the targets with a valid mapping.
6. Leave the other targets in `stuck`.

One run can send several requests, and it can continue in later jobs under the request budget. All of them belong to the action of the user. No periodic search of other seasons stays in the queue after the run.

## 3. Real cases

The implementation must cover the state that the 118 has now, and the 20-episode example.

### Lupin

Observed state:

- TMDB season 2: 7 episodes.
- Episodes 1-5 are available.
- Episodes 6-7 are stuck.
- Reason: `too_many_attempts`, detail `pack_partial`.
- Attempt counter: 3.
- `continuation`: null.
- TMDB has a season 3 already.
- The stored rejected releases are empty.

The action must be offered for this state. A season 3 in TMDB must not stop a search of release season 3.

The mapping must use the whole season as context. Two missing episodes do not mean that files E01 and E02 of another release are those two episodes.

### Jujutsu Kaisen

Observed state:

- TMDB season 1: 59 episodes.
- Episodes 1-47 are available.
- Episodes 48-59 are stuck.
- Attempt counters: 4-5.
- Stored continuation: release season 2, from episode 48.
- No search job holds those targets.

The action must work with those counters, and it must check the stored continuation.

The mapping `release S2E01 -> TMDB S1E48` is not valid only because `continuation` says so. An older inference can be incomplete.

The tests must check the identity of the imported episodes, not only the state of the target.

## 4. Keep a partial pack away from the attempt limit

### Current problem

In `packages/server/src/library/grab/finder.ts`:

```text
partial()
  -> calculates continuation
  -> fallback()
  -> checks attempt >= 3
  -> blocks before it queues the search
```

A partial pack shares the path of a damaged release. The limit also reads the history counter, which a manual retry increases.

### Change

Give the missing targets of a pack their own reason:

```text
state.kind = blocked
state.problem.code = pack_partial
```

For this case:

- Record the result of the inspection of the pack.
- Keep the data that the manual search needs.
- Block the targets that the pack does not cover.
- Do not use the generic `fallback()` that uses attempts and queues another search.
- Do not report `too_many_attempts` for a difference of season split.

The history keeps the earlier operations. Do not set `attempt` to zero.

### Existing stuck targets

The action accepts:

```text
pack_partial
```

and the format that Lupin and Jujutsu have now:

```text
too_many_attempts
  detail = pack_partial
```

The user does not remove and add the series again. An old continuation alone does not permit an automatic search of other seasons.

## 5. Store the real context of the pack

Today `partial()` calculates the coverage from the targets of that run. When every target of the run is missing, it can store:

```text
numbers: []
```

although the torrent holds other episodes of the series. That record says that the pack does not cover the current targets. It does not say how the release splits the series.

### Data to keep

From the inspection, keep:

- The identity of the release.
- The season that the release names.
- The numbers of the files that it holds.
- The TMDB episodes that those files identify.
- The requested targets that stay without a file.
- The mappings that the app checked already.

Keep two lists apart:

1. What the pack holds.
2. What this run needs.

The second list can be empty while the first is not.

### Old states

When the user starts the action:

1. Use the stored mappings and references that are still valid.
2. Read the files of the torrent in the client when it is necessary to rebuild the context.
3. Treat an old continuation without enough evidence as a hypothesis.
4. Do not map automatically when the data contradicts itself.

Do not claim that the update recovers data that an older version discarded.

## 6. Map the two numberings

This is the main part of the change.

### 6.1. The target keeps its identity

A target such as `tv:<id>:1x11` stays TMDB S1E11, although its file comes from a release named S2E01.

The season of the query never replaces the season of the target.

### 6.2. Map the whole block

Calculate the place of a file over the whole block of episodes, before the code removes the available ones.

```text
Known mapping:
  release S2E01 -> TMDB S1E11
  release S2E02 -> TMDB S1E12
  release S2E03 -> TMDB S1E13

If TMDB S1E11 is available:
  release S2E02 is still TMDB S1E12.
```

Remove nothing from the block when the code filters the targets.

### 6.3. Tell two situations apart

**Continuation of a season:**

```text
release S2E01 -> TMDB S1E11
```

**A whole season under another number:**

```text
release S3E01 -> TMDB S2E01
```

Both can have missing episodes, and each one needs a different mapping. The count of missing episodes does not select between them.

### 6.4. Evidence for the mapping

Use the data that the app has:

- Mappings that the app checked already.
- The numbering and the files of earlier packs.
- Absolute numbers when they apply.
- Episode names.
- Air dates when they identify one episode.
- The files of the downloads that the client has.

An air date that every episode of a season shares identifies no episode.

The code has parsers in `library/parse.ts` and `library/content.ts`. `matchContent()` belongs to the manual mapping proposal, not to the normal importer. Do not assume that it solves this flow.

### 6.5. Several splits in a row

One TMDB season can match several seasons of the releases. The data must hold more than one block. Do not limit it to `TMDB season + 1`. Do not keep a continuation to S2 when the data shows that the block is covered.

### 6.6. Ambiguous mapping

If two mappings stay possible:

- Do not give the first file to the first missing target.
- Leave those targets without a file.
- Log the data that is missing or contradictory.

A test passes only when the mapping is correct. An empty gap in the library is not a pass.

## 7. API action

### Contract

Extend the existing route `POST /api/queue/actions`:

```json
{
  "action": "search_other_seasons",
  "group": {
    "titleKey": "tv:96677",
    "season": 2
  }
}
```

The action uses the existing target selection and the existing preview.

### Checks

The server reads the targets from their current state. A target must:

- Belong to a series.
- Belong to the selected season.
- Be pending.
- Have a partial pack, in the new or in the old format.
- Belong to a title that allows a search.

The preview names only the targets that pass. The action of a season with five available and two stuck targets covers the two stuck targets.

### Run

1. Check again when the action starts.
2. Record that the user asked for other seasons.
3. Open the targets for this run.
4. Queue one job for each group.
5. Publish the queue change.

Two clicks at the same time must not make two searches or two reservations for the same targets.

### Files

- `packages/shared/src/enums.ts`
- `packages/shared/src/types.ts`
- `packages/shared/src/queue.ts`
- `packages/server/src/core/reasons.ts`
- `packages/server/src/routes/queue/actions/post.ts`

## 8. A search mode of its own

Add a mode to `SearchPayload` for other seasons. `manual: true` is not enough: a retry and a normal single search use it too. The mode tells apart:

- A normal search.
- A manual search of other seasons.

Update `enqueueSearch()` so that it:

- Keeps the two modes in different jobs.
- Groups the targets of one action.
- Stops a second search of the same targets.
- Keeps the mode when a run continues.

The job keeps the lock of the title.

### Find the seasons of the releases

The candidate seasons come from the releases and from the known evidence. They do not come from TMDB alone.

1. Read the season or the blocks that the app knows.
2. Ask the indexers for the title to find other seasons.
3. Group the results by the season of the release.
4. Read which group can cover the targets.
5. Send the queries that the group needs.

This needs a title query that names no season at the start, with the capabilities of the indexer.

### Names and aliases

Use the names and aliases of the title. In this mode, releases that do not cover the targets must not stop the search of the other names. Releases found is not a solution found.

### Old episodes

This search includes the episodes that the user selected, also when they are outside the recent window. `outside_recent_window` is not a valid result for these targets.

### Release choice

Keep the normal quality and choice rules. The button starts another search strategy. It does not accept any release.

### Budget and the end of the run

Use the request budget and the continuation of a job. Keep apart:

- A technical continuation of the run that the user started.
- A new search that something queues after that run.

Only the first one belongs to this action.

If the run ends without a file:

- Keep the result of the search.
- Keep the targets in `stuck`.
- Do not queue a periodic search of other seasons.
- Let the user start the action again.

## 9. Attempts, restarts, and recovery

### Counters

Keep the history apart from the budget of the manual run:

- The history stays visible.
- A partial pack does not use the budget of the search for a difference of numbering.
- A new manual action is not used up because `attempt` is 3, 4, or 5.
- A real download error keeps a limit inside its run.

### Restart

If the app restarts during a run of the user:

- Recover that job.
- Keep its mode and its targets.
- Keep the mapping that the app checked.
- Do not turn it into a normal search.

### Automatic work

Read `sweep()`, `recoverLost()`, the RSS sync, and the retries. None of them starts this mode only because it finds:

- `pack_partial`.
- An old continuation.
- A next search date.
- One stuck target.

Only an action of the user starts this mode.

## 10. Check of the pack and import

The app uses the chosen mapping through the whole path:

```text
search -> choice -> inspection of the torrent -> download -> validation -> import
```

### Before the download

The inspection compares the numbers of the release through the chosen mapping. Without it, a correct S2 release looks partial again for the S1 targets of TMDB.

### Torrent in the client

If the client has the torrent:

- Read its files.
- Use the data that it gives.
- Do not get a second copy of the same release.
- Continue only the targets of this action.

### Import

The importer gets the same mapping. A file named S2E01 goes to TMDB S1E11 when the app checked that mapping.

The final check reads:

- The target.
- The file.
- The file reference of the episode.
- The episodes of the file.
- The final path for the target.

### Files

- `packages/server/src/library/grab/decide.ts`
- `packages/server/src/library/grab/grab.ts`
- `packages/server/src/library/parse.ts`
- `packages/server/src/library/downloads/poller.ts`
- `packages/server/src/library/imports/importer.ts`

## 11. Activity page

### Place

Put **Search other seasons** next to the reason of the stuck target, in the card of the season. Align the action to the right edge. Use a `Button` of `nebula` and the existing queue action flow.

### Visibility

Show the action when the season has targets with a partial pack. Read that from the targets, not from the problem that the aggregate chose. It must show for the current state of Lupin and Jujutsu.

### While the request runs

- Show the pending state of the button.
- Stop a second request.
- Refresh the card with the queue events.
- Show the real state of the job.

`Try again` stays in the menu of the three points.

### Message

Keep a short reason about the episodes that the pack does not hold. The button holds the instruction.

### Files

- `packages/webapp/src/pages/activity/activity.tsx`
- `packages/webapp/src/lib/format.ts`
- `packages/webapp/src/i18n/es.ts`

## 12. Tests before the code

The tests state the behavior first. The author of the tests and the author of the code are different people, as the rules of the project require.

### A. Detection and wait

1. TMDB has 20 episodes, and the pack holds the first 10.
2. The first 10 continue.
3. The rest stay in `stuck`.
4. No other season is asked before the action.
5. The sweep starts no such search.
6. A restart starts none.

### B. Action and old states

1. The action accepts `pack_partial`.
2. It accepts `too_many_attempts` with detail `pack_partial`.
3. It works with attempt counters of 3, 4, and 5.
4. The preview holds the targets that pass only.
5. Two requests at the same time make one run.
6. A change of state between the preview and the run is obeyed.

### C. Basic mapping

1. Release S2E01-E10 maps to TMDB S1E11-E20.
2. The search asks for the right targets.
3. The inspection of the torrent accepts the mapping.
4. The files go to the right targets.
5. The test compares files and mappings, not only states.

### D. Part of the block is available

1. Some episodes of the other block are available.
2. The app asks for the missing ones only.
3. The numbers do not move when the available episodes leave the request.
4. A release with available and missing episodes goes to the requested targets only.

### E. Lupin

Repeat:

- TMDB S2 with 7 episodes.
- 5 available and 2 stuck.
- S3 in the catalog.
- Attempt 3.
- No continuation.
- No rejected releases.

The S3 of TMDB must not stop the search. S2E06-E07 must not go to the first two files that the search found.

### F. Jujutsu Kaisen

Repeat:

- TMDB S1 with 59 episodes.
- 47 available.
- 12 pending.
- Attempts 4-5.
- An old continuation.
- Releases split in more than two blocks.

The app must find the right block. It must not use the old continuation without a check.

### G. Incomplete or ambiguous results

1. No other season has a result.
2. Results exist, but none covers the targets.
3. The releases do not fit the qualities.
4. Two possible mappings contradict each other.
5. Several episodes share an air date.
6. Two episodes share a name.
7. The new pack covers a part only.

Each case logs its result. The targets that stay unsolved stay so.

### H. Jobs in the background

1. The run reaches the request budget.
2. The continuation keeps the mode and the targets.
3. The app restarts during the run.
4. A normal search of the same season runs at the same time.
5. The manual run ends with no result.

The last case shows that no other-season search stays in the queue.

### I. Page

1. The button shows for both formats of the reason.
2. The action covers the missing targets of the season.
3. The pending state stops a second click.
4. The page shows the change without a reload.
5. `Try again` stays in the menu.

### Tests that change

Some tests in `pipeline.test.ts` and `search-features.test.ts` expect the automatic continuation. They must read:

```text
partial pack -> wait for the user -> the action -> the other-season search -> the right mapping and import
```

Keep the checks of files, coverage, and the missing second download.

## 13. Order of the work

### Phase 1: contract and regressions

- Define the selection and the states.
- Write the basic case, Lupin, and Jujutsu.
- Make sure that they catch the current faults.

Check: the tests show the problem before the change.

### Phase 2: partial pack

- Take it out of the generic `fallback()`.
- Keep the coverage data.
- Leave the missing targets for the action.

Check: no partial pack starts the other-season search alone.

### Phase 3: mapping

- Map whole blocks.
- Handle old and obsolete continuations.
- Check the mapping against the episodes that are available.

Check: each file goes to the expected episode.

### Phase 4: API and job

- Add the action.
- Separate the search mode.
- Handle duplicate requests, continuation, and the end of the run.

Check: one action makes one run for the right targets.

### Phase 5: the whole path

- Use the mapping in the choice, the inspection, the tracking, and the import.

Check: the mapping reaches the library unchanged.

### Phase 6: page

- Add the button and the pending state.
- Check it with the old states.

Check: the user starts the flow from both stuck targets.

### Phase 7: checks

- Run the tests of each phase.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run the end-to-end tests that change.
- Check the normal packs and the retries.

## 14. Final check on the 118

After the install:

1. Read the version and the two groups.
2. Check that both offer the new action.
3. Check that the update started no other-season search.
4. Check the preview of Lupin: its two missing episodes.
5. Check the preview of Jujutsu: its twelve missing episodes.
6. When the user starts the action, follow the queries and the mappings.
7. Check the file of each target that becomes available.
8. If no release fits, check that the result is explained and the run ends.

Done means: the user starts the search with the state that the two titles have now, and each solved episode has the right file. A visible button, or a target that leaves `stuck`, does not prove the fix.
