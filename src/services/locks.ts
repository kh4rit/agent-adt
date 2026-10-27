import type { AbapSystem } from "../connection.js"
import { errorMessage } from "../format.js"
import { label, type ResolvedObject } from "../objects.js"

/**
 * Tells whether an object can be locked for editing right now, by locking it in a stateful
 * session and releasing it at once (what Eclipse does when an editor switches to change mode).
 * ADT cannot list or release locks of other sessions: those are cleared when their session
 * ends, or by the user in SM12.
 */
export async function lockStatus(system: AbapSystem, obj: ResolvedObject): Promise<string> {
  system.assertWritable("checking the edit lock")
  try {
    const lock = await system.withLock(obj.lockUrl, async l => l)
    const problems = system.takeUnlockProblems()
    const recorded = lock.CORRNR ? ` It is recorded in transport ${lock.CORRNR}${lock.CORRUSER ? ` (${lock.CORRUSER})` : ""}.` : lock.IS_LOCAL ? " It is a local object." : ""
    return [`${label(obj)} is not locked: the tool locked it and released it again at once.${recorded}`, ...problems].join("\n")
  } catch (e) {
    const message = errorMessage(e)
    if (/currently editing|already being edited|EU\/510|T100KEY-NO=510/i.test(message)) {
      const user = message.match(/User (\S+) is currently editing/i)?.[1]
      const own = user && user.toUpperCase() === system.user
      return [
        `${label(obj)} is locked${user ? ` by ${user}` : ""}.`,
        own
          ? "That is the tool's own user: an earlier SAP session of the tool (or an editor of the user) still holds the lock. It is released when that session ends, usually within minutes; otherwise the user deletes the entry in SM12. ADT cannot release a lock of another session."
          : "Another user is editing it. Ask them to close the editor or release the lock; do not delete lock entries.",
        message
      ].join("\n")
    }
    throw e
  }
}
