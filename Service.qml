import QtQuick
import Quickshell
import Quickshell.Io

// Eventloom service.
//
// `omarchy plugin add` only clones this repository; it runs nothing. This
// service is what sets eventloom up: shortly after it loads it runs
// plugin/setup.sh, which installs the CLI, the omp extension and the Claude
// Code hooks, and does so again whenever the checkout has changed (after
// `omarchy plugin update`). When nothing has changed the script exits at once.
//
// The service draws nothing. A failed setup is announced with one
// notification; the log's own health is `eventloom doctor`.
//
// A notification is sent by running a command, and a command's arguments can
// be read by every user of the machine. So notifications carry a verdict and
// where to look, never what a script or the doctor printed: that can quote
// the user's own files (a settings.json that does not parse, for one). The
// detail stays here, for `status`, and in the terminal.
//
// IPC (omarchy-shell eventloom <method>):
//   status     JSON: { state, detail } — state is checking, installing,
//              ready or failed
//   install    run the installer again now
//   doctor     run `eventloom doctor` and notify its verdict (healthy, or
//              how many problems; the problems themselves are not notified)
//   tapestry   open the Tapestry in the browser
Item {
  id: service

  // Injected by omarchy-shell.
  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string pluginDir: Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "").replace(/\/$/, "")
  readonly property string cli: home + "/.local/bin/eventloom"

  property string setupState: "checking"
  property string detail: ""

  // `message` is fixed text, at most with a count or this plugin's path.
  function notify(message, urgency) {
    Quickshell.execDetached(["omarchy-notification-send", "-u", urgency || "low", message])
  }

  // The last line that says something: installers end with their verdict.
  function lastLine(text) {
    var lines = String(text || "").split("\n").filter(function(line) { return line.trim() !== "" })
    return lines.length ? lines[lines.length - 1].trim() : ""
  }

  function runSetup(force) {
    if (setupProc.running) return "already running"
    service.setupState = force ? "installing" : "checking"
    setupProc.command = force ? ["sh", service.pluginDir + "/plugin/setup.sh", "--force"]
                          : ["sh", service.pluginDir + "/plugin/setup.sh"]
    setupProc.running = true
    return "started"
  }

  // Waits for the session to settle: a shell restart should not race the
  // network or the agents this installs adapters for.
  Timer {
    interval: 5000
    running: true
    repeat: false
    onTriggered: service.runSetup(false)
  }

  Process {
    id: setupProc
    stdout: StdioCollector { id: setupOut; waitForEnd: true }
    stderr: StdioCollector { id: setupErr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode === 0) {
        service.setupState = "ready"
        service.detail = service.lastLine(setupOut.text)
        return
      }
      service.setupState = "failed"
      service.detail = service.lastLine(setupErr.text) || service.lastLine(setupOut.text) || ("setup exited " + exitCode)
      console.warn("eventloom: setup failed (" + exitCode + "); `omarchy-shell eventloom status` has the reason")
      service.notify("Eventloom could not be installed. Run " + service.pluginDir
        + "/install.sh in a terminal to see why.", "normal")
    }
  }

  Process {
    id: doctorProc
    stdout: StdioCollector { id: doctorOut; waitForEnd: true }
    onExited: function(exitCode) {
      var problems = String(doctorOut.text || "").split("\n").filter(function(line) {
        return line.indexOf("fail") === 0 || line.indexOf("warn") === 0
      })
      if (exitCode === 0 && problems.length === 0) service.notify("Eventloom: the log is healthy.")
      else service.notify("Eventloom doctor found " + (problems.length || "a") + (problems.length > 1 ? " problems" : " problem")
        + ". Run `eventloom doctor` in a terminal to see them.", "normal")
    }
  }

  IpcHandler {
    target: "eventloom"

    function status(): string {
      return JSON.stringify({ state: service.setupState, detail: service.detail })
    }

    function install(): string {
      return service.runSetup(true)
    }

    function doctor(): string {
      if (doctorProc.running) return "already running"
      doctorProc.command = [service.cli, "doctor"]
      doctorProc.running = true
      return "started"
    }

    function tapestry(): string {
      Quickshell.execDetached(["sh", service.pluginDir + "/plugin/open-tapestry.sh"])
      return "ok"
    }
  }
}
