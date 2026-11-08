/**
 * The extension's user-facing commands, in groups: the archive, SWHIDs,
 * citations, and the others.
 *
 * @remarks
 * {@link Commands} builds the groups; those that need it share one
 * {@link CommandContext}, which finds "where the user is" and holds the
 * Software Heritage client. Each public method of a
 * group implements one or more commands registered in `extension.ts`, except
 * {@link ArchiveCommands.doSave}, which the SWHID commands also use. They talk
 * to the archive through {@link Swh}, show their results with the helpers of
 * `helpers.ts`, and report problems by throwing {@link core!UserError}:
 * {@link registerCommands}, which registers them, shows the errors.
 *
 * The groups depend on each other in one direction only: citations use the
 * SWHID commands, which use the archive commands to send save requests.
 *
 * @packageDocumentation
 */

export * from './archive';
export * from './citation';
export * from './commands';
export * from './context';
export * from './misc';
export * from './register';
export * from './swhid';
