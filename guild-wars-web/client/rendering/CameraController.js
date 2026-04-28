import * as THREE from 'three'

export default class CameraController {
  constructor(camera, renderer) {
    this.camera = camera
    this.renderer = renderer

    // Orbital parameters (spherical coordinates)
    this.targetPosition = new THREE.Vector3(25, 0, 25) // Point to orbit around on terrain
    this.distance = 45 // Fixed distance from target (for isometric view)
    this.azimuth = Math.PI / 4 // 45 degrees (NE direction)
    this.elevation = Math.PI / 6 // 30 degrees above horizontal

    // Zoom (orthographic camera scale)
    this.minZoom = 0.5
    this.maxZoom = 3.0
    this.camera.zoom = 1.0

    // Panning state
    this.isPanning = false
    this.panStartTerrainPos = null
    this.gazeLockWorldPoint = null // World point locked under cursor during middle mouse drag

    // Keyboard state
    this.keys = {}

    this.setupEventListeners()
    this.updateCameraPosition()
  }

  setupEventListeners() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e))
    document.addEventListener('keyup', (e) => this.onKeyUp(e))
    document.addEventListener('wheel', (e) => this.onMouseWheel(e), { passive: false })
    document.addEventListener('mousedown', (e) => this.onMouseDown(e))
    document.addEventListener('mousemove', (e) => this.onMouseMove(e))
    document.addEventListener('mouseup', (e) => this.onMouseUp(e))
  }

  onKeyDown(e) {
    const rotationStep = Math.PI / 2 // 90 degrees

    // Skip D if shift is pressed (debug mode uses Shift+D)
    if (e.code === 'KeyD' && e.shiftKey) {
      return
    }

    if (e.code === 'KeyQ') {
      this.azimuth -= rotationStep
      this.updateCameraPosition()
      e.preventDefault()
    } else if (e.code === 'KeyE') {
      this.azimuth += rotationStep
      this.updateCameraPosition()
      e.preventDefault()
    } else if (e.key.toLowerCase() === 'f') {
      this.frameAllContent()
      e.preventDefault()
    } else if (e.code === 'Home') {
      this.centerOnMap()
      e.preventDefault()
    } else {
      this.keys[e.code.toLowerCase()] = true
    }
  }

  onKeyUp(e) {
    // Also skip D on key up if shift was pressed during the press
    if (e.code === 'KeyD' && e.shiftKey) {
      return
    }
    this.keys[e.code.toLowerCase()] = false
  }

  onMouseWheel(e) {
    e.preventDefault()
    const zoomFactor = 1.15
    const direction = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor
    this.camera.zoom *= direction
    this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom))
    this.camera.updateProjectionMatrix()
  }

  onMouseDown(e) {
    if (e.button === 1) { // Middle mouse button
      this.isPanning = true
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY

      // Gaze lock: find world point under cursor at drag start
      const worldPoint = this.raycastToTerrain(e.clientX, e.clientY)
      this.gazeLockWorldPoint = worldPoint
      e.preventDefault()
    }
  }

  onMouseMove(e) {
    if (this.isPanning && this.gazeLockWorldPoint) {
      // Get current world point under cursor
      const currentWorldPoint = this.raycastToTerrain(e.clientX, e.clientY)

      if (currentWorldPoint) {
        // Calculate offset to keep gaze-lock point under cursor
        const offset = new THREE.Vector3().subVectors(this.gazeLockWorldPoint, currentWorldPoint)
        this.targetPosition.add(offset)
        this.updateCameraPosition()
      }

      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
    }
  }

  onMouseUp(e) {
    if (e.button === 1) {
      this.isPanning = false
      this.panStartTerrainPos = null
    }
  }

  raycastToTerrain(screenX, screenY) {
    // Get canvas position
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = screenX - rect.left
    const y = screenY - rect.top

    // For orthographic camera, convert screen position directly to world position
    const aspect = rect.width / rect.height
    const frustumHeight = 80
    const frustumWidth = frustumHeight * aspect
    const frustumHalfHeight = frustumHeight / 2
    const frustumHalfWidth = frustumWidth / 2

    // Normalized screen coordinates (-1 to 1)
    const normX = (x / rect.width) * 2 - 1
    const normY = -(y / rect.height) * 2 + 1

    // World position at the same height as camera
    const worldX = this.targetPosition.x + normX * frustumHalfWidth / this.camera.zoom
    const worldZ = this.targetPosition.z + normY * frustumHalfHeight / this.camera.zoom

    return new THREE.Vector3(worldX, 0, worldZ)
  }

  updateCameraPosition() {
    // Convert spherical coordinates to cartesian
    // elevation = angle above horizontal plane
    // azimuth = rotation around vertical axis

    const horizontalDistance = this.distance * Math.cos(this.elevation)
    const verticalDistance = this.distance * Math.sin(this.elevation)

    const x = this.targetPosition.x + horizontalDistance * Math.cos(this.azimuth)
    const y = this.targetPosition.y + verticalDistance
    const z = this.targetPosition.z + horizontalDistance * Math.sin(this.azimuth)

    this.camera.position.set(x, y, z)
    this.camera.lookAt(this.targetPosition)
  }

  frameAllContent() {
    // Reset target to map center and zoom out to see everything
    this.targetPosition.set(25, 0, 25)
    this.camera.zoom = 0.6
    this.camera.updateProjectionMatrix()
    this.updateCameraPosition()
  }

  centerOnMap() {
    // Reset to home isometric view
    this.targetPosition.set(25, 0, 25)
    this.azimuth = Math.PI / 4 // 45 degrees
    this.elevation = Math.PI / 6 // 30 degrees
    this.camera.zoom = 1.0
    this.camera.updateProjectionMatrix()
    this.updateCameraPosition()
  }

  update() {
    // Handle WASD camera movement (horizontal panning)
    const moveSpeed = 1.5
    let moved = false

    if (this.keys['keyw']) {
      const moveDir = new THREE.Vector3(0, 0, -1)
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.azimuth)
      this.targetPosition.addScaledVector(moveDir, moveSpeed)
      moved = true
    }
    if (this.keys['keys']) {
      const moveDir = new THREE.Vector3(0, 0, 1)
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.azimuth)
      this.targetPosition.addScaledVector(moveDir, moveSpeed)
      moved = true
    }
    if (this.keys['keya']) {
      const moveDir = new THREE.Vector3(-1, 0, 0)
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.azimuth)
      this.targetPosition.addScaledVector(moveDir, moveSpeed)
      moved = true
    }
    if (this.keys['keyd']) {
      const moveDir = new THREE.Vector3(1, 0, 0)
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.azimuth)
      this.targetPosition.addScaledVector(moveDir, moveSpeed)
      moved = true
    }

    if (moved) {
      this.updateCameraPosition()
    }
  }
}
