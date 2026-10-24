#!/bin/bash
# The nightly job (docs/deployment.md, "The nightly job"): sync Pinboard, join
# the issues, run the three enrichment tools one after another, validate data/,
# then commit data/ and public/media/ and push to main, which deploys.
#
#   tools/nightly.sh [--dry-run] [--hosts N] [--facts N] [--wayback N] [repo]
#
# repo defaults to /Users/otto/Projects/links.thingelstad.xyz. The checkout must
# be on main and clean; anything else exits 2 before a file is touched.
# --dry-run checks the checkout and prints the plan: no network, no writes (not
# even the log or the lock), and no secret is read.
#
# Exit codes: 0 done (or nothing to commit); 1 a step failed (sync, join,
# validation or the push; the tree is left as it is); 2 the preflight refused
# (wrong branch, a dirty tree, diverged from origin, another run holds the
# lock); 64 a bad argument.
#
# Neither .env nor the GitHub token is ever echoed: no `set -x`, and every tool
# reads its secret from the environment.

set -euo pipefail

REPO="/Users/otto/Projects/links.thingelstad.xyz"
HOSTS_LIMIT=1000
FACTS_LIMIT=500
WAYBACK_LIMIT=800
DRY_RUN=0
LOG_DIR="${LINKS_NIGHTLY_LOG_DIR:-$HOME/Library/Logs/links}"
LOG="$LOG_DIR/nightly.log"
LOCK="$LOG_DIR/nightly.lock"
PUSH_WAITS=(2 4 8 16)
COMMITTER=(-c "user.name=Linking Things nightly" -c "user.email=links-nightly@thingelstad.com")

usage() {
	sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit "${1:-64}"
}

count() {
	[[ "${2:-}" =~ ^[0-9]+$ ]] || {
		echo "nightly: $1 takes a whole number" >&2
		exit 64
	}
}

while (($#)); do
	case "$1" in
	--dry-run) DRY_RUN=1 ;;
	--hosts) count "$1" "${2:-}"; HOSTS_LIMIT="$2"; shift ;;
	--facts) count "$1" "${2:-}"; FACTS_LIMIT="$2"; shift ;;
	--wayback) count "$1" "${2:-}"; WAYBACK_LIMIT="$2"; shift ;;
	-h | --help) usage 0 ;;
	-*) echo "nightly: unknown option $1" >&2; usage ;;
	*) REPO="$1" ;;
	esac
	shift
done

stamp() { TZ=America/Chicago date '+%Y-%m-%d %H:%M:%S %Z'; }

# The log is written only by a real run; a dry run prints to stdout alone.
log() {
	local line
	line="$(stamp) $*"
	echo "$line"
	if ((!DRY_RUN)); then
		echo "$line" >>"$LOG"
	fi
}

refuse() {
	log "refused: $*"
	exit 2
}

fail() {
	log "FAILED: $*"
	exit 1
}

git_ro() { git --no-optional-locks -C "$REPO" "$@"; }

# Preflight. Nothing here writes, except fetch, fast-forward and an earlier
# run's unpushed commit, and those only in a real run.

[[ -d "$REPO/.git" ]] || {
	echo "nightly: $REPO is not a git checkout" >&2
	exit 2
}

if ((!DRY_RUN)); then
	mkdir -p "$LOG_DIR"
	if ! mkdir "$LOCK" 2>/dev/null; then
		holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
		if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
			refuse "another run (pid $holder) holds $LOCK"
		fi
		log "removing a stale lock (pid ${holder:-unknown} is gone)"
		rm -rf "$LOCK"
		mkdir "$LOCK" || refuse "could not take $LOCK"
	fi
	echo "$$" >"$LOCK/pid"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/links-nightly.XXXXXX")"
cleanup() {
	rm -rf "$WORK"
	if ((!DRY_RUN)) && [[ "$(cat "$LOCK/pid" 2>/dev/null || true)" == "$$" ]]; then
		rm -rf "$LOCK"
	fi
}
trap cleanup EXIT
trap 'log "interrupted"; exit 1' INT TERM

if ((DRY_RUN)); then
	log "nightly: start in $REPO (dry run)"
else
	log "nightly: start in $REPO"
fi

branch="$(git_ro rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || refuse "the checkout is on $branch, not main"
dirty="$(git_ro status --porcelain)"
[[ -z "$dirty" ]] || refuse "the tree is not clean ($(echo "$dirty" | wc -l | tr -d ' ') path(s) changed or untracked)"

if ((DRY_RUN)); then
	log "preflight: on main, clean; not fetching (dry run), comparing with the last fetched origin/main"
else
	git -C "$REPO" fetch --quiet origin main || refuse "git fetch origin main failed"
fi
read -r behind ahead < <(git_ro rev-list --left-right --count origin/main...HEAD)

push_with_retries() {
	local attempt=0
	while true; do
		if git -C "$REPO" push --quiet origin HEAD:main; then
			return 0
		fi
		if ((attempt >= ${#PUSH_WAITS[@]})); then
			return 1
		fi
		log "push failed; trying again in ${PUSH_WAITS[$attempt]} s"
		sleep "${PUSH_WAITS[$attempt]}"
		attempt=$((attempt + 1))
	done
}

if ((ahead > 0 && behind > 0)); then
	refuse "main has diverged from origin/main ($ahead ahead, $behind behind)"
elif ((ahead > 0)); then
	if ((DRY_RUN)); then
		log "preflight: would push $ahead earlier commit(s) first"
	else
		log "preflight: pushing $ahead earlier commit(s) first"
		push_with_retries || refuse "could not push the earlier commit(s)"
	fi
elif ((behind > 0)); then
	if ((DRY_RUN)); then
		log "preflight: would fast-forward $behind commit(s) from origin/main"
	else
		git -C "$REPO" merge --quiet --ff-only origin/main || refuse "git merge --ff-only origin/main failed"
		log "preflight: fast-forwarded $behind commit(s)"
	fi
else
	log "preflight: up to date with origin/main"
fi

cd "$REPO"
PY=(python3 -I)
STEPS=()

# step <label> <ok exit codes, comma-separated> <command...>
# Runs one tool with its output in the log, keeps its last line for the commit
# message, and sets STEP_CODE.
step() {
	local label="$1" allowed="$2" out="$WORK/$1.out" last
	shift 2
	STEP_CODE=0
	"$@" >"$out" 2>&1 || STEP_CODE=$?
	cat "$out" >>"$LOG"
	last="$(tail -n 1 "$out")"
	[[ -n "$last" ]] || last="(no output)"
	if [[ ",$allowed," == *",$STEP_CODE,"* ]]; then
		log "$label: exit $STEP_CODE: $last"
	else
		log "$label: FAILED with exit $STEP_CODE: $last"
	fi
	if ((STEP_CODE)); then
		STEPS+=("- $last (exit $STEP_CODE)")
	else
		STEPS+=("- $last")
	fi
}

if ((DRY_RUN)); then
	log "plan: load .env and GITHUB_TOKEN from gh auth token (not read in a dry run)"
	log "plan: tools/sync.py (exit 3, rate limited, is logged and the run goes on), then tools/join_issues.py"
	# The enrichment tools' own dry runs: offline, no writes (-B: no bytecode either).
	for planned in "enrich_hosts.py --limit $HOSTS_LIMIT" "enrich_facts.py --limit $FACTS_LIMIT" \
		"enrich_pages.py --wayback-only --limit $WAYBACK_LIMIT"; do
		read -r -a words <<<"$planned"
		code=0
		python3 -I -B "tools/${words[0]}" "${words[@]:1}" --dry-run >"$WORK/plan.out" 2>&1 || code=$?
		last="$(tail -n 1 "$WORK/plan.out")"
		if ((code)); then
			last="its dry run exited $code: $last"
		fi
		log "plan: tools/$planned: $last"
	done
	log "plan: tools/validate_data.py; a failure stops the run before the commit"
	log "plan: git add data public/media; commit as Linking Things nightly, \"Nightly: sync and enrichment, $(TZ=America/Chicago date +%F)\"; push to origin main (retries after ${PUSH_WAITS[*]} s)"
	log "nightly: dry run done; nothing fetched, run or written"
	exit 0
fi

# Secrets: into the environment, never onto the screen or into the log.
if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
else
	log "no .env: tools/sync.py will say PINBOARD_API_TOKEN is not set"
fi
GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)"
export GITHUB_TOKEN
[[ -n "$GITHUB_TOKEN" ]] || log "no GitHub token from gh auth token: enrich_facts asks GitHub without one"

step sync "0,3" "${PY[@]}" tools/sync.py
if ((STEP_CODE == 3)); then
	log "sync: rate limited by Pinboard; the run goes on with the links as they are"
elif ((STEP_CODE != 0)); then
	fail "tools/sync.py exited $STEP_CODE; nothing committed"
fi
step join "0" "${PY[@]}" tools/join_issues.py
((STEP_CODE == 0)) || fail "tools/join_issues.py exited $STEP_CODE; nothing committed"

# One after another, never in parallel. A tool that stops early (a rate limit,
# a bot wall, Wayback refusing) has already written what it learned; the
# validation below decides whether that is committed.
step hosts "0" "${PY[@]}" tools/enrich_hosts.py --limit "$HOSTS_LIMIT"
step facts "0" "${PY[@]}" tools/enrich_facts.py --limit "$FACTS_LIMIT"
step wayback "0,1" "${PY[@]}" tools/enrich_pages.py --wayback-only --limit "$WAYBACK_LIMIT"

step validate "0" "${PY[@]}" tools/validate_data.py
((STEP_CODE == 0)) || fail "tools/validate_data.py found problems; the tree is left as it is for a look"

paths=(data)
[[ -d public/media ]] && paths+=(public/media)
git add -- "${paths[@]}"
if git diff --cached --quiet; then
	log "nightly: done, nothing changed"
	exit 0
fi
day="$(TZ=America/Chicago date +%F)"
message="$WORK/message"
{
	echo "Nightly: sync and enrichment, $day"
	echo
	printf '%s\n' "${STEPS[@]}"
} >"$message"
git "${COMMITTER[@]}" commit --quiet --file "$message"
log "committed $(git rev-parse --short HEAD): $(git diff --shortstat HEAD~1 HEAD)"

if ! push_with_retries; then
	# origin/main may have moved during the run: rebase the data commit onto it
	# once, validate again and push again.
	git fetch --quiet origin main || fail "push failed and git fetch failed; the commit waits for the next run"
	if ! git merge-base --is-ancestor origin/main HEAD; then
		git "${COMMITTER[@]}" rebase --quiet origin/main || {
			git rebase --abort || true
			fail "push failed and the commit does not rebase onto origin/main; it waits in the checkout"
		}
		step revalidate "0" "${PY[@]}" tools/validate_data.py
		((STEP_CODE == 0)) || fail "validation failed after rebasing onto origin/main"
	fi
	push_with_retries || fail "git push failed after every retry; the next run pushes it first"
fi
log "nightly: done, pushed $(git rev-parse --short HEAD) to origin main"
