# Deep Review

A tool for reviewing a pull request through the lens of one function: how its
callers and callees change across the PR, and how a changed code path can be
traced end to end.

## Language

### Analysis

**Target**:
The function named as the entry point of an analysis. Everything else is
described relative to it.
_Avoid_: subject, focus function

**Caller**:
A function that invokes another, found via the language server's incoming
calls.
_Avoid_: parent, consumer

**Callee**:
A function invoked by another, found via the language server's outgoing
calls.
_Avoid_: child, dependency

**Before / After**:
The two revisions of the repository being compared: the PR's base commit and
its head commit.
_Avoid_: old/new (reserved for the two coordinate systems inside a diff
hunk), left/right

**Presence**:
Which revisions a function exists in: before only, after only, or both.

**Changed**:
A function is changed when at least one of the PR's diff hunks overlaps its
body on either side, or when it exists in only one revision.
_Avoid_: touched, modified, dirty

**Hunk**:
One contiguous block of a unified diff (`@@ -a,b +c,d @@` plus its lines).
The unit in which PR changes are attached to functions.

### Slicing

**Slice**:
A set of fragments that together accomplish one coherent change. Slices are
ordered by how central they are to what the PR is for: reverting the first
slice would defeat the PR's purpose, reverting the last would barely dent it.
_Avoid_: group, cluster, theme

**Fragment**:
A contiguous run of lines inside one hunk, and the unit a slice is built
from. Hunks are too coarse to assign directly — a newly added file arrives
as one hunk that may serve several unrelated purposes — so hunks are cut
into fragments and fragments are what slices hold.
_Avoid_: chunk (collides with hunk), segment, sub-hunk

**Partition**:
The invariant the slicing agent's output must satisfy: every added and
removed line of the diff belongs to exactly one fragment, and every fragment
to exactly one slice. Checked mechanically, because a change assigned to no
slice and a change assigned to two both read as normal output.

**Hunk id**:
A hunk's stable address — its head-side path and its index among that file's
hunks, e.g. `src/report.ts#2`. Fragment ids extend it with their line range:
`src/report.ts#2@14-31`.

**Hunk-local line**:
A line's 1-based position within a hunk body, counting context, added, and
removed lines alike. The coordinate fragments are defined in, and distinct
from the line's position in the file.

**Annotated diff**:
The rendering of the diff handed to the slicing agent: each hunk labeled
with its id, each line carrying both its hunk-local number and its head-side
file line. The contract between the prompt and the partition check.

**Call site**:
The exact place (line and column span) where a caller invokes a function.
Call sites always live in the caller's source.

**Snapshot**:
Everything known about one function in one revision: its location, source,
and call sites.

**Walk**:
The recursive traversal outward from the target, in both the caller and
callee directions, that expands through changed functions and stops at
unchanged ones.

**Boundary**:
The first unchanged function reached in some direction of the walk. It is
included in the result but its own callers/callees are not walked, so it
brackets the changed code path.
_Avoid_: leaf, edge (of the graph — collides with caller→callee edges)

**Node / Edge**:
The walked call graph's parts: a node is a function (identified by file and
name); an edge is one caller→callee relationship carrying its call sites.

**Embedded file**:
The full text and symbol table of a source file carried inside a report so
the page can reveal any part of the file (expanders, scope labels) on its
own. Only the files the slices touch and the call graphs reach are embedded;
anything else is fetched from the navigation server as a window.

**Navigation server**:
The local loopback HTTP server `pr-review` runs behind an explorer page. It
keeps the language services warm over the PR's head checkout and answers
the page's questions as symbols are clicked: where a symbol is defined
(`/definition`), who calls it (`/references`), and the rendered panel for a
definition (`/panel`). Nothing is resolved ahead of time and nothing is
capped; the page starts small and learns as it is read. It stops on Ctrl-C
or shortly after the page goes away.
_Avoid_: backend (collides with language backend), API

### Report UI

**Layout**:
One of the report's three presentations: **stacked** (callers above the
target, callees below), **columns** (callers | target | callee), and
**explorer** (the recursive navigator).

**Explorer**:
The recursive navigation layout: every function is a panel, two panels are
visible at a time, and tapping symbols walks the call path in either
direction with an iOS-style slide.

**Panel**:
One function's card in the explorer: its badges, called-by rows, diff, and
source.

**Slice explorer**:
The two-axis fusion of slices and the explorer. Vertically it moves between
slices in priority order; horizontally each slice walks its own call graph.
The two axes are independent — every slice keeps its own track and position.

**Deck**:
The vertical stack of slice views, one filling the stage at a time. The
vertical counterpart of a track.
_Avoid_: carousel, stack (overloaded), pager

**Description view**:
What the sidebar's PR Description entry shows in place of the deck: the PR as
its author wrote it, rendered from Markdown, plus the slicer's own overview
of what the PR does. The one view of the page that is not code, and the
sidebar's other kind of destination — a slice, or this.
_Avoid_: description tab, readme, notes, body (reserved for a hunk's or an
issue's text)

**Slice panel**:
The first panel in a slice's track: the slice's title, summary, rationale,
and every fragment's diff. The starting point for a horizontal walk.

**Overscroll**:
Continuing to scroll after a slice's content has run out. Past a threshold
it carries the reader to the adjacent slice — down from the bottom, up from
the top.
_Avoid_: bounce, rubber-band (the browser's own effect, which this replaces)

**Walk down**:
Navigate from a function to one of its callees by tapping a call in its
source. The callee's panel appears on the right; the view slides left.

**Walk up**:
Navigate from a function to one of its callers by tapping a called-by row.
The caller's panel is revealed on the left; the view slides right.

**Rail**:
The thin vertical bar on either screen edge representing a collapsed panel;
tapping it slides the view one step in that direction.
_Avoid_: sidebar, handle

**Called-by row**:
The tappable row at the top of a panel listing one incoming call — the way
to walk up.

**Expander**:
The GitHub-style widget standing in for hidden lines, revealing twenty at a
time (up, down, or all), labeled with the hidden-line count and a breadcrumb.
_Avoid_: gap (the hidden region itself, not the widget)

**Breadcrumb**:
The chain of enclosing symbols (outermost to innermost, e.g.
`class Ky › #retry()`) shown on expanders and hunk headers so hidden context
stays identifiable.
_Avoid_: crumb (shorthand), symbol path

**Context padding**:
The ten lines of surrounding file content shown on each side of a function
in an explorer panel, the way a diff tool pads a hunk.

**Added-line tint**:
The green background on lines the PR added, applied only within the
function's own body — never to context padding.

**Call mark**:
The tinted, tappable span over a call expression in a panel's source — the
way to walk down.
_Avoid_: call-site highlight, link

**Symbol link**:
The paired blue highlights created by a navigation tap, tying the symbol
that was clicked to the panel it opened.

**Clicked mark**:
The symbol-link half on the symbol that was tapped: it turns accent blue,
then fades to low opacity as the panes slide, staying visible as a trail
marker.

**Destination mark**:
The symbol-link half in the opened panel: the function's name on its
declaration line, shown directly in the low-opacity blue so the eye can pair
it with the clicked mark one pane over.
