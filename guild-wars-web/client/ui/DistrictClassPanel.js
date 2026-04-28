import TerrainColors from '../rendering/TerrainColors.js'

const DISTRICT_CLASSES = ['Commerce', 'Military', 'Magical', 'Religious', 'Noble', 'Slums', 'Entertainment', 'Industrial', 'Agricultural']

export default class DistrictClassPanel {
  constructor(eventBus) {
    this.eventBus = eventBus
    this.container = null
  }

  render(container) {
    this.container = container
    container.innerHTML = ''

    const label = document.createElement('div')
    label.textContent = 'Select District Class:'
    label.style.cssText = 'margin-bottom:10px;font-size:12px;color:#aaa'
    container.appendChild(label)

    const buttonContainer = document.createElement('div')
    buttonContainer.style.cssText = 'display:grid;grid-template-columns:1fr;gap:5px'

    for (const districtClass of DISTRICT_CLASSES) {
      const btn = document.createElement('button')
      const color = TerrainColors.get(districtClass)
      btn.textContent = districtClass
      btn.style.cssText = `padding:8px;background:#2a2a2a;border:2px solid ${color};color:#fff;cursor:pointer;border-radius:3px;font-size:11px`
      btn.addEventListener('click', () => this.eventBus.emit('DISTRICT_CLASS_ASSIGNED', { districtClass }))
      buttonContainer.appendChild(btn)
    }

    container.appendChild(buttonContainer)
    this.addFinishButton(container)
  }

  addFinishButton(container) {
    const finishBtn = document.createElement('button')
    finishBtn.textContent = 'Finish District Assignment'
    finishBtn.style.cssText = 'width:100%;padding:10px;margin-top:15px;background:#3d5a3d;color:#fff;border:1px solid #4a7c59;cursor:pointer;border-radius:3px'
    finishBtn.addEventListener('click', () => this.eventBus.emit('SUBDIVISION_COMPLETE'))
    container.appendChild(finishBtn)
  }
}
