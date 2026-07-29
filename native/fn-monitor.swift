// Globe / Fn push-to-talk support for macOS.
//
// macOS never reports Globe/Fn as a key press. It arrives only as the
// `maskSecondaryFn` modifier flag on flagsChanged events, which is why
// libuiohook maps that keycode to VC_UNDEFINED and the normal keyboard hook
// can never see it. This helper taps flagsChanged directly and reports the
// transitions on stdout so the app can treat Globe/Fn as hold-to-talk:
//
//   FN_READY           tap installed, listening
//   FN_DOWN / FN_UP    the key was pressed / released
//   FN_TAP_REENABLED   macOS disabled the tap and we put it back
//
// Exits 2 if the tap cannot be created, which in practice means Accessibility
// permission has not been granted - the caller surfaces that to the user.
//
// Listen-only tap: it observes events and never modifies or swallows them, so
// Globe keeps doing whatever the user has it set to do in System Settings.

import Foundation
import CoreGraphics

var fnDown = false
var tapPort: CFMachPort?

func emit(_ s: String) {
    print(s)
    fflush(stdout)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .flagsChanged:
        let down = event.flags.contains(.maskSecondaryFn)
        if down != fnDown {
            fnDown = down
            emit(down ? "FN_DOWN" : "FN_UP")
        }
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // macOS disables a tap that is slow to respond, or on certain user
        // input. Without re-enabling, the key silently stops working - the
        // same failure mode the keyboard hook had.
        if let t = tapPort {
            CGEvent.tapEnable(tap: t, enable: true)
            emit("FN_TAP_REENABLED")
        }
    default:
        break
    }
    return Unmanaged.passUnretained(event)
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
) else {
    FileHandle.standardError.write(Data("FN_ERROR accessibility-denied\n".utf8))
    exit(2)
}

tapPort = tap
let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("FN_READY")
CFRunLoopRun()
