export class Staircase {
  constructor(min_val, max_val, step_size) {
    this.min_val = min_val
    this.max_val = max_val
    this.step_size = step_size
    this.current_val = max_val // always start at top
    // this.history = [] // {stim: val, correct: t/f}
  }

  next() {
    return this.current_val
  }

  update(correct) {
    // this.history.push({stim: this.current_val, correct: correct})
    this.current_val += this.step_size * (correct ? -1 : 1)
    if (this.current_val > this.max_val) {
      this.current_val = this.max_val
    }
    if (this.current_val < this.min_val) {
      this.current_val = this.min_val
    }
  }
}
