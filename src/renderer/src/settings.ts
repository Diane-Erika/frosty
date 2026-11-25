const snowingBox = document.getElementById('snowing') as HTMLInputElement
const focusBox = document.getElementById('focus') as HTMLInputElement
const opacitySlider = document.getElementById('opacity') as HTMLInputElement
const opacityLabel = document.getElementById('opacity-value') as HTMLSpanElement

snowingBox.addEventListener('change', () =>
  window.snowAPI.sendCmd({ type: 'snowing', value: snowingBox.checked }))

focusBox.addEventListener('change', () =>
  window.snowAPI.sendCmd({ type: 'focus', value: focusBox.checked }))

for (const rateButton of document.querySelectorAll<HTMLInputElement>('input[name="rate"]')) {
  rateButton.addEventListener('change', () =>
    window.snowAPI.sendCmd({ type: 'rate', value: Number(rateButton.value) }))
}

// 'input' fires while dragging, so the snow changes live
opacitySlider.addEventListener('input', () => {
  opacityLabel.textContent = opacitySlider.value + '%'
  window.snowAPI.sendCmd({ type: 'opacity', value: Number(opacitySlider.value) / 100 })
})

document.getElementById('refill')!.addEventListener('click', () => window.snowAPI.sendCmd({ type: 'refill' }))
document.getElementById('clear')!.addEventListener('click', () => window.snowAPI.sendCmd({ type: 'clear' }))
document.getElementById('quit')!.addEventListener('click', () => window.snowAPI.quit())