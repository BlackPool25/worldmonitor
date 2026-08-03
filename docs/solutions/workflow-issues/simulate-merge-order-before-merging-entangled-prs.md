---
title: "Simulate the merge order before merging entangled PRs — file overlap is not conflict"
date: 2026-08-03
category: workflow-issues
module: "development workflow, git merge sequencing"
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Several open PRs touch an overlapping file set and someone asks which order to merge them in"
  - "Deciding whether a PR needs a rebase before merging, or whether it will land clean"
  - "Two PRs appear to duplicate each other's work and you need to know whether merging both is safe"
  - "A stack of feature PRs each restore or add one member of a shared collection that a test counts"
  - "Estimating how much conflict-resolution work a merge queue implies"
tags:
  - git
  - merge-order
  - merge-tree
  - conflict-prediction
  - semantic-conflict
  - pr-sequencing
---

# Simulate the merge order before merging entangled PRs

## Context

Seven open PRs (#6073, #6076, #6077, #6081, #6083, #6084, #6094) all touched the
China nowcast / corridor / PortWatch area, and the question was which order to
merge them in. The obvious approach — group them by shared filenames and assume
overlap means conflict — produces a scary and wrong picture. Those seven shared a
lot of files: five of them touched
`tests/china-activity-nowcast-handler.test.mts`, three touched
`server/worldmonitor/economic/v1/get-china-activity-nowcast.ts`, and two pairs
shared more than twenty files each.

The actual answer was that **six of the seven merged clean and exactly one file
ever conflicted**, but only under one specific ordering. A different ordering
doubled the conflict count. Neither fact is derivable from a file list.

## Guidance

### 1. Measure conflicts, don't infer them from filenames

`git merge-tree` performs a real three-way merge and writes the result to the
object database without touching the working tree, the index, or HEAD. It is
safe to run against any number of branch pairs while you have unrelated work
checked out.

```bash
# Fetch every PR head as a local ref first.
for n in 6073 6076 6077 6081 6083 6084 6094; do
  git fetch origin "pull/$n/head:pr-$n" --force --quiet
done

# Real pairwise conflict matrix. Exit status is non-zero on conflict.
for a in 6073 6076 6077 6081 6083 6084 6094; do
  for b in 6073 6076 6077 6081 6083 6084 6094; do
    [ "$a" -lt "$b" ] || continue
    out=$(git merge-tree --write-tree --messages "pr-$a" "pr-$b" 2>&1) || \
      echo "CONFLICT $a <-> $b: $(printf '%s\n' "$out" | grep '^CONFLICT' | sed 's/.*in //')"
  done
done
```

For the seven PRs above this printed exactly two lines. Everything else — every
pair sharing twenty-plus files — merged clean.

### 2. Chain simulated merges to compare whole orderings

A pairwise matrix tells you which PRs collide; it does not tell you the cheapest
sequence. Chain `merge-tree` through `commit-tree` to replay an entire order
against the real base, again without touching the working tree:

```bash
simulate () {
  local cur=$(git rev-parse origin/main) name="$1"; shift
  local conflicts=0
  for pr in "$@"; do
    local out tree
    out=$(git merge-tree --write-tree "$cur" "pr-$pr" 2>&1) || conflicts=$((conflicts+1))
    tree=$(printf '%s\n' "$out" | head -1)
    cur=$(git commit-tree "$tree" -p "$cur" -p "pr-$pr" -m "merge $pr")
  done
  echo "$name => $conflicts conflict(s); head $cur"
}

simulate "A" 6076 6084 6073 6094 6077 6083 6081   # => 1 conflict
simulate "B" 6076 6084 6073 6094 6077 6081 6083   # => 2 conflicts
```

`commit-tree` turns each simulated merge into a real commit object, so the next
iteration merges against the accumulated state rather than against the original
base. The resulting head is a normal commit you can `git show` and inspect.

**Merge the conflict hub last.** #6081 collided with both #6077 and #6083, while
#6077 and #6083 did not collide with each other. Ordering the hub last costs one
resolution; ordering it in the middle costs two. That asymmetry is invisible
without the simulation.

### 3. Inspect the auto-merged regions, not just the conflicts

This is the part the tooling will not do for you. Across #6077, #6081 and #6083,
`get-china-activity-nowcast.ts` and `shared/china-activity-nowcast-registry.ts`
auto-merged with **no conflict at all** — each PR appended a different proxy
family to the same function and the same registry array. The only thing git
flagged was the *test* that counts the result.

The conflict was the canary; the silent auto-merge was where a real defect would
have lived. Verify the union directly on the simulated head:

```bash
git show "${SIMULATED_HEAD}:server/worldmonitor/economic/v1/get-china-activity-nowcast.ts" \
  | grep -cE "seriesId: '"        # expect every family, not a subset
```

### 4. Do not predict the merged value of a counted assertion — run the test

When several PRs each add a member to a collection that a test counts, it is
tempting to do the arithmetic and tell the resolver what number to write. That
prediction was made here and it was **wrong**.

Reasoning said: main asserted `eligibleFamilies: 5` with
`missingInputs: ['energy', 'corridor']`; #6081 restores the energy family and
#6083 restores the corridor family; therefore the resolved value must be `7` with
`missingInputs: []`. The real answer after merging was `6` with
`missingInputs: ['corridor']`, and the suite passes.

The flaw: family restoration is not unconditional. #6081's energy change is
published directly by the corridor signal the fixture already supplies, so energy
does restore. #6083's corridor-breadth change requires a *persisted prior
snapshot* from Redis, which that unit fixture never provides — so corridor stays
excluded in that test by design, even though the production capability now
exists.

A counted assertion depends on the fixture, not only on the feature set. Resolve
the conflict by taking both sides' new cases, then let the suite tell you the
number.

### 5. Clean-merging duplicates still deserve a read

#6073 and #6094 shared 24 files and merged clean. Diffing them file by file
showed 19 byte-identical diffs and 5 divergent ones — and on the divergent five,
#6073 was the *fuller* version (its copy of one module was 206 lines against
#6094's 156, its test 607 against 472). Merging both was safe, and the simulated
union preserved the fuller version, which is worth confirming rather than
assuming:

```bash
T=$(git merge-tree --write-tree pr-6073 pr-6094 | head -1)
git show "$T:scripts/_portwatch-content-freshness.mjs" | wc -l   # 206, the fuller side
```

A clean merge between two branches doing overlapping work is not evidence the
work was not duplicated. It is only evidence git could reconcile the text.

## Why This Matters

Merge sequencing gets decided by intuition — usually "merge the small ones first"
or "merge mine first" — and the cost of a wrong guess is paid in conflict
resolutions on the largest, most entangled PRs, which is exactly where a
hand-resolution is most likely to silently drop one side's intent.

The simulation is cheap: seven PRs, twenty-one pairs and two full seven-step
orderings took a few seconds and touched nothing. It converts an argument into a
measurement, and it surfaces the two things that matter and are otherwise
invisible — which PR is the conflict hub, and which regions merged silently.

## When to Apply

Run it when three or more open PRs touch a shared area, when two PRs look like
they duplicate each other, or before advising anyone on merge order. Skip it for
independent PRs in unrelated directories — the pairwise matrix on two unrelated
branches will just print nothing.

Note that `merge-tree --write-tree` needs Git 2.38+. Verify with `git --version`
before relying on the exit status; older builds have a different, non-conflict-aware
`merge-tree`.

## Examples

The full result for the seven PRs, and what actually happened:

| Step | PR | Simulated | Actual |
| --- | --- | --- | --- |
| 1 | #6076 | clean | clean |
| 2 | #6084 | clean | clean |
| 3 | #6073 | clean | clean |
| 4 | #6094 | clean | clean |
| 5 | #6077 | clean | clean |
| 6 | #6083 | clean | clean |
| 7 | #6081 | conflict in one test file | conflict, resolved, suite green |

Merged main was then verified independently of CI: 126 tests across the nowcast,
corridor, decision-signal and shipping suites, plus 170 across the seeder,
contract, PortWatch and MCP suites — all passing.

**Cleanup.** The `pr-*` refs are local scaffolding for the analysis. Remove them
when done so they do not accumulate across worktrees sharing one object store:

```bash
for n in 6073 6076 6077 6081 6083 6084 6094; do git branch -D "pr-$n"; done
```

## Related

- `docs/solutions/design-patterns/contract-gate-field-names-miss-value-axis.md` —
  the schema-drift gate closed by #6078/#6084, one of the PRs sequenced here
- `docs/solutions/conventions/verify-the-verifier-mutation-test-every-detection-layer.md` —
  mutation-testing the guards that a merge like this can silently weaken
