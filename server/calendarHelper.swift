import AppKit
import EventKit
import Foundation

func emit(_ value: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
  exit(0)
}

func accessName() -> String {
  switch EKEventStore.authorizationStatus(for: .event) {
  case .notDetermined: return "notDetermined"
  case .restricted, .denied: return "denied"
  default: return "granted"
  }
}

func hex(_ color: CGColor?) -> Any {
  guard let color, let rgb = NSColor(cgColor: color)?.usingColorSpace(.sRGB) else { return NSNull() }
  return String(format: "#%02x%02x%02x", Int(rgb.redComponent * 255), Int(rgb.greenComponent * 255), Int(rgb.blueComponent * 255))
}

func orNull(_ text: String?) -> Any {
  guard let text, !text.isEmpty else { return NSNull() }
  return text
}

func participantStatus(_ status: EKParticipantStatus) -> String {
  switch status {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  default: return "pending"
  }
}

func describe(_ event: EKEvent) -> [String: Any] {
  let occurrence = event.occurrenceDate ?? event.startDate!
  let attendees: [[String: Any]] = (event.attendees ?? []).map {
    [
      "name": $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: ""),
      "email": $0.url.scheme == "mailto" ? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") : NSNull(),
      "status": participantStatus($0.participantStatus),
      "room": $0.participantType == .room || $0.participantType == .resource,
      "me": $0.isCurrentUser,
    ]
  }
  return [
    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
    "externalId": orNull(event.calendarItemExternalIdentifier),
    "occurrence": occurrence.timeIntervalSince1970,
    "calendarId": event.calendar.calendarIdentifier,
    "calendar": event.calendar.title,
    "account": event.calendar.source.title,
    "color": hex(event.calendar.cgColor),
    "title": event.title ?? "(no title)",
    "start": event.startDate.timeIntervalSince1970,
    "end": event.endDate.timeIntervalSince1970,
    "allDay": event.isAllDay,
    "location": orNull(event.location),
    "notes": orNull(event.notes),
    "url": orNull(event.url?.absoluteString),
    "recurring": event.hasRecurrenceRules,
    "editable": event.calendar.allowsContentModifications,
    "attendees": attendees,
  ]
}

final class Answer { var granted = false }

func openStore() -> EKEventStore {
  let store = EKEventStore()
  let answer = Answer()
  let done = DispatchSemaphore(value: 0)
  let completion: (Bool, Error?) -> Void = { granted, _ in
    answer.granted = granted
    done.signal()
  }
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents(completion: completion)
  } else {
    store.requestAccess(to: .event, completion: completion)
  }
  done.wait()
  if !answer.granted { emit(["access": "denied"]) }
  return store
}

func payload(_ raw: String?) -> [String: Any] {
  guard let raw, let data = raw.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    emit(["access": "granted", "error": "the request could not be read"])
  }
  return object
}

func date(_ value: Any?) -> Date? {
  guard let seconds = value as? Double else { return nil }
  return Date(timeIntervalSince1970: seconds)
}

func find(_ store: EKEventStore, _ request: [String: Any]) -> EKEvent {
  guard let id = request["id"] as? String, let occurrence = date(request["occurrence"]) else {
    emit(["access": "granted", "error": "the request names no event"])
  }
  let window = store.predicateForEvents(withStart: occurrence.addingTimeInterval(-86_400), end: occurrence.addingTimeInterval(86_400), calendars: nil)
  let candidates = store.events(matching: window).filter { $0.eventIdentifier == id }
  let exact = candidates.first { abs(($0.occurrenceDate ?? $0.startDate).timeIntervalSince(occurrence)) < 1 }
    ?? candidates.first { abs($0.startDate.timeIntervalSince(occurrence)) < 1 }
  if let event = exact ?? (candidates.count == 1 ? candidates.first : nil) ?? store.event(withIdentifier: id) { return event }
  emit(["access": "granted", "error": "that event is no longer in the calendar"])
}

func span(_ request: [String: Any]) -> EKSpan {
  (request["span"] as? String) == "future" ? .futureEvents : .thisEvent
}

func apply(_ request: [String: Any], to event: EKEvent, in store: EKEventStore) {
  if let title = request["title"] as? String { event.title = title }
  if let allDay = request["allDay"] as? Bool { event.isAllDay = allDay }
  if let start = date(request["start"]) { event.startDate = start }
  if let end = date(request["end"]) { event.endDate = end }
  if let location = request["location"] as? String { event.location = location.isEmpty ? nil : location }
  if let notes = request["notes"] as? String { event.notes = notes.isEmpty ? nil : notes }
  if let calendarId = request["calendarId"] as? String, calendarId != event.calendar?.calendarIdentifier {
    guard let target = store.calendar(withIdentifier: calendarId), target.allowsContentModifications else {
      emit(["access": "granted", "error": "that calendar cannot be changed"])
    }
    event.calendar = target
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let mode = arguments.first ?? "status"

switch mode {
case "status":
  emit(["access": accessName()])

case "events":
  let store = openStore()
  guard arguments.count > 2, let from = Double(arguments[1]), let to = Double(arguments[2]) else {
    emit(["access": "granted", "error": "events needs a start and an end"])
  }
  let window = store.predicateForEvents(withStart: Date(timeIntervalSince1970: from), end: Date(timeIntervalSince1970: to), calendars: nil)
  let events = store.events(matching: window).filter { $0.status != .canceled }.map(describe)
  emit(["access": "granted", "events": events])

case "calendars":
  let store = openStore()
  let fallback = store.defaultCalendarForNewEvents?.calendarIdentifier
  let calendars: [[String: Any]] = store.calendars(for: .event).map {
    [
      "id": $0.calendarIdentifier,
      "title": $0.title,
      "account": $0.source.title,
      "color": hex($0.cgColor),
      "editable": $0.allowsContentModifications,
      "isDefault": $0.calendarIdentifier == fallback,
    ]
  }
  emit(["access": "granted", "calendars": calendars])

case "create":
  let store = openStore()
  let request = payload(arguments.count > 1 ? arguments[1] : nil)
  let event = EKEvent(eventStore: store)
  event.calendar = store.defaultCalendarForNewEvents
  apply(request, to: event, in: store)
  guard event.calendar != nil else { emit(["access": "granted", "error": "there is no calendar to add the event to"]) }
  do {
    try store.save(event, span: .thisEvent, commit: true)
    emit(["access": "granted", "event": describe(event)])
  } catch {
    emit(["access": "granted", "error": error.localizedDescription])
  }

case "update":
  let store = openStore()
  let request = payload(arguments.count > 1 ? arguments[1] : nil)
  let event = find(store, request)
  guard event.calendar.allowsContentModifications else { emit(["access": "granted", "error": "this calendar is read-only"]) }
  apply(request, to: event, in: store)
  do {
    try store.save(event, span: span(request), commit: true)
    emit(["access": "granted", "event": describe(event)])
  } catch {
    emit(["access": "granted", "error": error.localizedDescription])
  }

case "delete":
  let store = openStore()
  let request = payload(arguments.count > 1 ? arguments[1] : nil)
  let event = find(store, request)
  do {
    try store.remove(event, span: span(request), commit: true)
    emit(["access": "granted"])
  } catch {
    emit(["access": "granted", "error": error.localizedDescription])
  }

default:
  emit(["access": accessName(), "error": "unknown command \(mode)"])
}
