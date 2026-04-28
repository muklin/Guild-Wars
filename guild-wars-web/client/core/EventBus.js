export default class EventBus {
  constructor() {
    this.events = new Map()
  }

  on(eventName, callback) {
    if (!this.events.has(eventName)) {
      this.events.set(eventName, new Set())
    }
    this.events.get(eventName).add(callback)
  }

  off(eventName, callback) {
    if (this.events.has(eventName)) {
      this.events.get(eventName).delete(callback)
    }
  }

  emit(eventName, data) {
    if (this.events.has(eventName)) {
      this.events.get(eventName).forEach(callback => callback(data))
    }
  }

  clear() {
    this.events.clear()
  }
}
