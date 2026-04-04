using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Event system using observer pattern for decoupled communication between systems.
/// Allows UI, phases, and other systems to react to game state changes without tight coupling.
/// </summary>
public class EventSystem : MonoBehaviour
{
    public static EventSystem Instance { get; private set; }

    private Dictionary<string, List<Delegate>> eventListeners = new();

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    // ==================== EVENT SUBSCRIPTION ====================

    /// <summary>
    /// Subscribe to an event with no parameters.
    /// </summary>
    public void Subscribe(string eventName, Action listener)
    {
        if (listener == null) return;

        if (!eventListeners.ContainsKey(eventName))
            eventListeners[eventName] = new List<Delegate>();

        eventListeners[eventName].Add(listener);
    }

    /// <summary>
    /// Subscribe to an event with one parameter.
    /// </summary>
    public void Subscribe<T>(string eventName, Action<T> listener)
    {
        if (listener == null) return;

        if (!eventListeners.ContainsKey(eventName))
            eventListeners[eventName] = new List<Delegate>();

        eventListeners[eventName].Add(listener);
    }

    /// <summary>
    /// Subscribe to an event with two parameters.
    /// </summary>
    public void Subscribe<T1, T2>(string eventName, Action<T1, T2> listener)
    {
        if (listener == null) return;

        if (!eventListeners.ContainsKey(eventName))
            eventListeners[eventName] = new List<Delegate>();

        eventListeners[eventName].Add(listener);
    }

    /// <summary>
    /// Subscribe to an event with three parameters.
    /// </summary>
    public void Subscribe<T1, T2, T3>(string eventName, Action<T1, T2, T3> listener)
    {
        if (listener == null) return;

        if (!eventListeners.ContainsKey(eventName))
            eventListeners[eventName] = new List<Delegate>();

        eventListeners[eventName].Add(listener);
    }

    // ==================== EVENT UNSUBSCRIPTION ====================

    public void Unsubscribe(string eventName, Action listener)
    {
        if (!eventListeners.ContainsKey(eventName)) return;
        eventListeners[eventName].Remove(listener);
    }

    public void Unsubscribe<T>(string eventName, Action<T> listener)
    {
        if (!eventListeners.ContainsKey(eventName)) return;
        eventListeners[eventName].Remove(listener);
    }

    public void Unsubscribe<T1, T2>(string eventName, Action<T1, T2> listener)
    {
        if (!eventListeners.ContainsKey(eventName)) return;
        eventListeners[eventName].Remove(listener);
    }

    public void Unsubscribe<T1, T2, T3>(string eventName, Action<T1, T2, T3> listener)
    {
        if (!eventListeners.ContainsKey(eventName)) return;
        eventListeners[eventName].Remove(listener);
    }

    // ==================== EVENT FIRING ====================

    public void Fire(string eventName)
    {
        if (!eventListeners.ContainsKey(eventName)) return;

        foreach (var listener in eventListeners[eventName])
        {
            if (listener is Action action)
                action?.Invoke();
        }
    }

    public void Fire<T>(string eventName, T parameter)
    {
        if (!eventListeners.ContainsKey(eventName)) return;

        foreach (var listener in eventListeners[eventName])
        {
            if (listener is Action<T> action)
                action?.Invoke(parameter);
        }
    }

    public void Fire<T1, T2>(string eventName, T1 param1, T2 param2)
    {
        if (!eventListeners.ContainsKey(eventName)) return;

        foreach (var listener in eventListeners[eventName])
        {
            if (listener is Action<T1, T2> action)
                action?.Invoke(param1, param2);
        }
    }

    public void Fire<T1, T2, T3>(string eventName, T1 param1, T2 param2, T3 param3)
    {
        if (!eventListeners.ContainsKey(eventName)) return;

        foreach (var listener in eventListeners[eventName])
        {
            if (listener is Action<T1, T2, T3> action)
                action?.Invoke(param1, param2, param3);
        }
    }

    // ==================== CLEANUP ====================

    public void ClearEvent(string eventName)
    {
        if (eventListeners.ContainsKey(eventName))
            eventListeners[eventName].Clear();
    }

    public void ClearAllEvents()
    {
        eventListeners.Clear();
    }
}
