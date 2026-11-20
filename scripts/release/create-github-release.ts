export type CommandRunner = (command: string[]) => Promise<number>;

export interface CreateGithubReleaseOptions {
	notesFile?: string;
	releaseTag?: string;
	run?: CommandRunner;
}

async function runCommand(command: string[]) {
	const proc = Bun.spawn(command, { stderr: "inherit", stdout: "inherit" });
	return await proc.exited;
}

export async function createGithubRelease(
	options: CreateGithubReleaseOptions = {},
) {
	const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
	const notesFile = options.notesFile ?? "release-notes.md";
	const run = options.run ?? runCommand;

	if (!releaseTag) throw new Error("RELEASE_TAG is required");

	const releaseExists =
		(await run(["gh", "release", "view", releaseTag])) === 0;
	if (releaseExists) {
		// A tag can be cut again — a re-run, or a release that was prepared from
		// different notes. Skipping the existing release then leaves the old
		// words in front of the new version, and the tag says nothing changed.
		// Editing is idempotent, so a repeated run costs nothing.
		const updated = await run([
			"gh",
			"release",
			"edit",
			releaseTag,
			"--notes-file",
			notesFile,
			"--latest",
		]);
		if (updated !== 0)
			throw new Error(`Failed to update GitHub Release ${releaseTag}`);
		return;
	}

	const exitCode = await run([
		"gh",
		"release",
		"create",
		releaseTag,
		"--title",
		releaseTag,
		"--notes-file",
		notesFile,
	]);
	if (exitCode !== 0)
		throw new Error(`Failed to create GitHub Release ${releaseTag}`);
}

if (import.meta.main) await createGithubRelease();
