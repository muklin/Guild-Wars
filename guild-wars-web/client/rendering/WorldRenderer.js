import * as THREE from 'three'
import CameraController from './CameraController.js'
import TerrainColors from './TerrainColors.js'

export default class WorldRenderer {
  constructor() {
    this.scene = null
    this.camera = null
    this.renderer = null
    this.cameraController = null
    this.regionMeshes = new Map()
    this.edgeMeshes = new Map()
    this.terrainData = null
    this.worldSize = 50
    this.isPaused = false
    this.godMode = false
    this.originalMaterials = new Map()
    this.debugObjects = []
    this.showDebug = false
    this.raycaster = new THREE.Raycaster()
    this.mouse = new THREE.Vector2()
    this.vertexData = new Map() // Maps mesh UUID to vertex info
  }

  init() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a1a)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = true
    document.body.insertBefore(this.renderer.domElement, document.body.firstChild)

    const aspect = window.innerWidth / window.innerHeight
    const frustumHeight = 80
    const frustumWidth = frustumHeight * aspect

    this.camera = new THREE.OrthographicCamera(
      -frustumWidth / 2,
      frustumWidth / 2,
      frustumHeight / 2,
      -frustumHeight / 2,
      0.1,
      1000
    )

    this.camera.position.set(25, 60, 25)
    this.camera.lookAt(25, 0, 25)

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    this.scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8)
    directionalLight.position.set(50, 100, 50)
    directionalLight.castShadow = true
    directionalLight.shadow.mapSize.width = 2048
    directionalLight.shadow.mapSize.height = 2048
    this.scene.add(directionalLight)

    this.cameraController = new CameraController(this.camera, this.renderer)
    window.addEventListener('resize', () => this.onWindowResize())
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        this.isPaused = !this.isPaused
        console.log(`Render loop ${this.isPaused ? 'PAUSED' : 'RESUMED'}`)
        e.preventDefault()
      }
      if (e.code === 'KeyG') {
        this.toggleGodMode()
        e.preventDefault()
      }
      if (e.code === 'KeyD') {
        this.toggleDebugVisualization()
        e.preventDefault()
      }
    })
    document.addEventListener('mousemove', (e) => this.onMouseMove(e))
    this.animate()
  }

  setTerrainData(regions, edges) {
    console.log('setTerrainData called with', regions.length, 'regions and', Object.keys(edges || {}).length, 'edges')
    this.terrainData = { regions, edges: edges || {} }
    this.renderTerrain(regions)
    this.drawVoronoiCenters(regions)
    if (edges && Object.keys(edges).length > 0) {
      this.renderEdges(edges)
    }
  }

  renderTerrain(regions) {
    this.regionMeshes.forEach(mesh => this.scene.remove(mesh))
    this.regionMeshes.clear()

    console.log(`%c=== TERRAIN RENDERING ===`, 'color: #0f0; font-weight: bold')
    console.log(`Rendering ${regions.length} regions`)
    let successCount = 0
    regions.forEach(region => {
      const mesh = this.buildRegionMesh(region)
      if (mesh) {
        this.scene.add(mesh)
        this.regionMeshes.set(region.id, mesh)
        successCount++
        console.log(`  ✓ Region ${region.id}: ${region.polygon.length} verts, bbox=${mesh.geometry.boundingBox.min.x.toFixed(1)}-${mesh.geometry.boundingBox.max.x.toFixed(1)}`)
      } else {
        console.log(`  ✗ Region ${region.id}: ${region.polygon.length} verts → FAILED`)
      }
    })
    console.log(`%c✓ Created ${successCount}/${regions.length} meshes | Scene: ${this.scene.children.length} children`, 'color: #0f0')
    console.log(`Camera: frustum left=${this.camera.left.toFixed(1)} right=${this.camera.right.toFixed(1)} top=${this.camera.top.toFixed(1)} bottom=${this.camera.bottom.toFixed(1)}`)
  }

  buildRegionMesh(region) {
    if (!region.polygon || region.polygon.length < 3) {
      console.warn(`Region ${region.id} has invalid polygon:`, region.polygon)
      return null
    }

    // Use raw polygon vertices - inset can break concave shapes by moving them across edges
    const polygon = [...region.polygon]
    polygon.reverse()
    const vertices = polygon.map(v => [v.x || 0, 0.05, v.y || 0]).flat()
    if (vertices.length === 0) {
      console.warn(`Region ${region.id} has empty vertices array`)
      return null
    }
    if (vertices.some(v => !isFinite(v))) {
      console.warn(`Region ${region.id} has non-finite vertices:`, vertices.slice(0, 12))
      return null
    }

    const triangles = []
    for (let i = 1; i < polygon.length - 1; i++) {
      triangles.push(0, i, i + 1)
    }

    if (triangles.length === 0) {
      console.warn(`Region ${region.id} has no triangles`)
      return null
    }

    console.log(`Region ${region.id}: ${polygon.length} verts → ${triangles.length/3} triangles`)

    let geometry
    try {
      const vertexArray = new Float32Array(vertices)
      const indexArray = new Uint32Array(triangles)
      console.log(`Region ${region.id} arrays: verts=${vertexArray.byteLength}, indices=${indexArray.byteLength}`)

      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(vertexArray, 3))
      const indexAttribute = new THREE.BufferAttribute(indexArray, 1)
      geometry.setIndex(indexAttribute)
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    } catch (e) {
      console.error(`Error creating geometry for region ${region.id}:`, e)
      return null
    }

    const color = TerrainColors.get(region.assignedType) || TerrainColors.unassigned
    const material = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.6,
      metalness: 0,
      emissive: color,
      emissiveIntensity: 0.2
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData = { regionId: region.id }
    return mesh
  }

  insetPolygon(polygon, inset) {
    if (polygon.length < 3 || inset <= 0) return polygon

    let centroidX = 0, centroidY = 0
    polygon.forEach(v => {
      centroidX += v.x
      centroidY += v.y
    })
    centroidX /= polygon.length
    centroidY /= polygon.length

    return polygon.map(v => {
      const dx = centroidX - v.x
      const dy = centroidY - v.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return { x: v.x, y: v.y }
      const nx = dx / dist
      const ny = dy / dist
      return { x: v.x + nx * inset, y: v.y + ny * inset }
    })
  }

  renderEdges(edges) {
    this.edgeMeshes.forEach(mesh => this.scene.remove(mesh))
    this.edgeMeshes.clear()

    console.log(`Rendering ${Object.keys(edges).length} edges`)
    let edgeCount = 0
    Object.entries(edges).forEach(([id, edge]) => {
      const mesh = this.buildEdgeMesh(edge, id)
      if (mesh) {
        this.scene.add(mesh)
        this.edgeMeshes.set(id, mesh)
        edgeCount++
      }
    })
    console.log(`Successfully created ${edgeCount} edge meshes`)
  }

  buildEdgeMesh(edge, edgeId) {
    const p1 = edge.startPoint
    const p2 = edge.endPoint
    if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number') {
      return null
    }

    const thickness = 0.5
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len === 0) return null

    const perpX = (-dy / len) * (thickness / 2)
    const perpY = (dx / len) * (thickness / 2)

    const vertices = [
      p1.x - perpX, 0.06, p1.y - perpY,
      p1.x + perpX, 0.06, p1.y + perpY,
      p2.x + perpX, 0.06, p2.y + perpY,
      p2.x - perpX, 0.06, p2.y - perpY
    ]

    if (vertices.some(v => !isFinite(v))) {
      return null
    }

    const triangles = [0, 1, 2, 0, 2, 3]

    let geometry
    try {
      const vertexArray = new Float32Array(vertices)
      const indexArray = new Uint32Array(triangles)

      if (!isFinite(vertexArray.byteLength) || !isFinite(indexArray.byteLength)) {
        console.warn(`Edge ${edgeId} has invalid array byte lengths`, vertexArray.byteLength, indexArray.byteLength)
        return null
      }

      geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(vertexArray, 3))
      const indexAttribute = new THREE.BufferAttribute(indexArray, 1)
      geometry.setIndex(indexAttribute)
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
    } catch (e) {
      console.error(`Error creating edge geometry ${edgeId}:`, e)
      return null
    }

    const color = edge.assignedType ? TerrainColors.get(edge.assignedType) : TerrainColors.unassigned
    const material = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.6,
      metalness: 0,
      emissive: color,
      emissiveIntensity: 0.5
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData = { edgeId }
    return mesh
  }

  updateRegionColor(regionId, terrainType) {
    const mesh = this.regionMeshes.get(regionId)
    if (mesh) {
      const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
      mesh.material.color.setHex(color)
    }
  }

  updateEdgeColor(edgeId, terrainType) {
    const mesh = this.edgeMeshes.get(edgeId)
    if (mesh) {
      const color = TerrainColors.get(terrainType) || TerrainColors.unassigned
      mesh.material.color.setHex(color)
    }
  }

  getRegionAtWorldPos(worldX, worldY) {
    if (!this.terrainData) return null

    for (const region of this.terrainData.regions) {
      if (this.pointInPolygon(worldX, worldY, region.polygon)) {
        return region
      }
    }
    return null
  }

  getEdgeAtWorldPos(worldX, worldY) {
    if (!this.terrainData || !this.terrainData.edges) return null

    const threshold = 1.5 // World-space distance threshold for edge detection
    let closestEdge = null
    let closestDistance = threshold

    for (const edgeId in this.terrainData.edges) {
      const edge = this.terrainData.edges[edgeId]
      const distance = this.distanceToLineSegment(
        worldX, worldY,
        edge.startPoint.x, edge.startPoint.y,
        edge.endPoint.x, edge.endPoint.y
      )

      if (distance < closestDistance) {
        closestDistance = distance
        closestEdge = { ...edge, id: edgeId }
      }
    }

    return closestEdge
  }

  distanceToLineSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1
    const dy = y2 - y1
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    const closestX = x1 + t * dx
    const closestY = y1 + t * dy
    const distX = px - closestX
    const distY = py - closestY
    return Math.sqrt(distX * distX + distY * distY)
  }

  pointInPolygon(x, y, polygon) {
    let inside = false
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y
      const xj = polygon[j].x, yj = polygon[j].y

      const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi) / (yj - yi) + xi))
      if (intersect) inside = !inside
    }
    return inside
  }

  onWindowResize() {
    const width = window.innerWidth
    const height = window.innerHeight
    const aspect = width / height
    const frustumHeight = 80
    const frustumWidth = frustumHeight * aspect

    this.camera.left = -frustumWidth / 2
    this.camera.right = frustumWidth / 2
    this.camera.top = frustumHeight / 2
    this.camera.bottom = -frustumHeight / 2
    this.camera.updateProjectionMatrix()

    this.renderer.setSize(width, height)
  }

  animate() {
    requestAnimationFrame(() => this.animate())

    if (!this.isPaused) {
      this.cameraController.update()
      try {
        this.renderer.render(this.scene, this.camera)
      } catch (e) {
        console.error('Render error:', e)
        console.log('Scene children:', this.scene.children.length)
        this.scene.children.forEach((child, i) => {
          if (child.geometry) {
            console.log(`Child ${i}:`, child.constructor.name, 'geometry:', child.geometry.attributes)
          }
        })
        throw e
      }
    }
  }

  toggleGodMode() {
    this.godMode = !this.godMode

    if (this.godMode) {
      this.scene.children.forEach((child) => {
        if (child.material) {
          this.originalMaterials.set(child, child.material)
          const hue = Math.random()
          const color = new THREE.Color().setHSL(hue, 0.7, 0.6)
          child.material = new THREE.MeshBasicMaterial({ color })
        }
      })
      console.log('God Mode ON')
    } else {
      this.scene.children.forEach((child) => {
        if (this.originalMaterials.has(child)) {
          child.material = this.originalMaterials.get(child)
        }
      })
      this.originalMaterials.clear()
      console.log('God Mode OFF')
    }
  }

  toggleDebugVisualization() {
    this.showDebug = !this.showDebug
    this.debugObjects.forEach(obj => {
      obj.visible = this.showDebug
    })
    console.log(`Debug visualization ${this.showDebug ? 'ON' : 'OFF'}`)
  }

  drawVoronoiCenters(regions) {
    // Remove old debug objects
    this.debugObjects.forEach(obj => this.scene.remove(obj))
    this.debugObjects = []

    // Draw seed points as small spheres
    const seedGeometry = new THREE.SphereGeometry(0.3, 8, 8)
    const seedMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 })
    regions.forEach(region => {
      const seed = new THREE.Mesh(seedGeometry, seedMaterial)
      seed.position.set(region.seedPoint.x, 0.15, region.seedPoint.y)
      seed.visible = this.showDebug
      this.scene.add(seed)
      this.debugObjects.push(seed)
    })

    // Draw polygon vertices as small cubes
    const vertGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2)
    const vertMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    regions.forEach(region => {
      region.polygon.forEach((vertex, vertexIndex) => {
        const vert = new THREE.Mesh(vertGeometry, vertMaterial)
        vert.position.set(vertex.x, 0.2, vertex.y)
        vert.visible = this.showDebug
        this.scene.add(vert)
        this.debugObjects.push(vert)
        // Store vertex metadata for hover display
        this.vertexData.set(vert.uuid, {
          regionId: region.id,
          vertexIndex,
          x: vertex.x,
          y: vertex.y,
          mesh: vert
        })
      })
    })

    console.log(`Drew ${regions.length} seed points and ${regions.reduce((sum, r) => sum + r.polygon.length, 0)} vertices`)
  }

  onMouseMove(event) {
    if (!this.showDebug || !this.camera) return

    // Convert mouse position to normalized device coordinates
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1

    // Raycasting
    this.raycaster.setFromCamera(this.mouse, this.camera)
    const intersects = this.raycaster.intersectObjects(this.debugObjects)

    let tooltip = document.getElementById('debug-tooltip')
    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.id = 'debug-tooltip'
      tooltip.style.cssText = `
        position: fixed;
        background: rgba(0, 200, 0, 0.9);
        color: #fff;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-family: monospace;
        pointer-events: none;
        z-index: 1000;
        display: none;
        border: 1px solid #0f0;
      `
      document.body.appendChild(tooltip)
    }

    if (intersects.length > 0) {
      const object = intersects[0].object
      const vertexInfo = this.vertexData.get(object.uuid)

      if (vertexInfo) {
        tooltip.style.display = 'block'
        tooltip.style.left = event.clientX + 10 + 'px'
        tooltip.style.top = event.clientY + 10 + 'px'
        tooltip.innerHTML = `
          Region ${vertexInfo.regionId}<br>
          Vertex ${vertexInfo.vertexIndex}<br>
          x: ${vertexInfo.x.toFixed(2)}<br>
          y: ${vertexInfo.y.toFixed(2)}
        `
      } else {
        tooltip.style.display = 'none'
      }
    } else {
      tooltip.style.display = 'none'
    }
  }
}
