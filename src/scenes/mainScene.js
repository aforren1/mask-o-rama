import { TypingText } from '../objects/typingtext'
import { Enum } from '../utils/enum'
import BasicExample from '../objects/examples'
import merge_data from '../utils/merge'
import { clamp } from '../utils/clamp'
import signedAngleDeg from '../utils/angulardist'
import { mad, median } from '../utils/medians'
import generateTrials from '../utils/trialgen'
import make_thick_arc from '../utils/arc'
import { Staircase } from '../utils/staircase'

const WHITE = 0xffffff
const GREEN = 0x39ff14 // actually move to the target
const RED = 0xff0000
const GRAY = 0x666666
const DARKGRAY = 0x444444
const LIGHTBLUE = 0x86c5da
const TARGET_SIZE_RADIUS = 15
const CURSOR_SIZE_RADIUS = 5
const CENTER_SIZE_RADIUS = 15
const MOVE_THRESHOLD = 4
const TARGET_DISTANCE = 300 // *hopefully* they have 300px available?
const TARGET_REF_ANGLE = 270 // degrees, and should be pointed straight up
const CURSOR_RESTORE_POINT = 30 //
const MOVE_SCALE = 0.5 // factor to combat pointer acceleration
const PI = Math.PI
let MAX_STAIRCASE = 10 // in frames
// generate the noise texture (512x512 so we're pretty sure it'll fit any screen, esp once
// it gets scaled up to 3x3 pixel blocks)
const NOISE_DIM = 512
let noise_tex = []
let tmp = ['0', '2'] // 0 = black, 2 = white for the arne16 palette
for (let i = 0; i < NOISE_DIM; i++) {
  noise_tex[i] = ''
  for (let j = 0; j < NOISE_DIM; j++) {
    noise_tex[i] += tmp[Math.floor(2 * Math.random())] // randomChoice
  }
}

// fill txts later-- we need to plug in instructions based on their runtime mouse choice
let instruct_txts = {}

const states = Enum([
  'INSTRUCT', // show text instructions (based on stage of task)
  'PRETRIAL', // wait until in center
  'MOVING', // shoot through / mask + animation (if probe)
  'QUESTIONS', // which side did cursor go to?
  'POSTTRIAL', // auto teleport back to restore point
  'END' //
])

const Err = {
  reached_away: 1,
  late_start: 2,
  slow_reach: 4,
  wiggly_reach: 8,
  returned_to_center: 16
}

function randint(min, max) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randchoice(arr) {
  return arr[Math.floor(arr.length * Math.random())]
}

function countTrials(array) {
  return array.filter((v) => !v['trial_type'].startsWith('instruct_')).length
}

export default class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' })
    this._state = states.INSTRUCT
    this.entering = true
    // these line up with trial_type
    this.all_data = {
      practice_basic: [], // practice reaching with vis feedback
      practice_mask: [],
      probe: []
    }
  }

  create() {
    let config = this.game.config
    let user_config = this.game.user_config
    let hand = user_config.hand // 'right' or 'left'
    // camera (origin is center)
    this.cameras.main.setBounds(-config.width / 2, -config.height / 2, config.width, config.height)
    let height = config.height
    let hd2 = height / 2
    this.trial_counter = 0
    this.entering = true
    this.state = states.INSTRUCT
    // used for imagery component
    this.rts = []
    this.movets = []
    this.practice_mask_mts = [] // used for setting simulated clamp speed & max of staircase
    this.is_debug = user_config.debug

    // based on mouse hand, select response keys
    let rk
    if (hand === 'right') {
      // left hand for response (wasd)
      rk = { side: { left: 'A', right: 'D' }, confidence: { guess: 'S', confident: 'W' } }
    } else {
      // left (ijkl)
      rk = { side: { left: 'J', right: 'L' }, confidence: { guess: 'K', confident: 'I' } }
    }
    this.resp_keys = rk

    // set number of repeats
    if (this.is_debug) {
      this.trials = generateTrials(5, user_config.clamp_size, true)
      this.typing_speed = 1
    } else {
      // 50 repeats = 100 trials in probe section
      this.trials = generateTrials(50, user_config.clamp_size, false)
      this.typing_speed = 50
    }
    // min of 1 frame, max of 10 frames (probably 166ms on 60hz machines?), steps of 1 frame
    // 1 up, 2 down (i.e. 2 correct to move a step down, 1 incorrect to move a step up)
    // this ends up getting overwritten once we've computed the per-user movement time
    this.staircase = new Staircase(1, MAX_STAIRCASE, 1, 2)

    // user cursor
    this.user_cursor = this.add.circle(CURSOR_RESTORE_POINT, CURSOR_RESTORE_POINT, CURSOR_SIZE_RADIUS, LIGHTBLUE) // controlled by user (gray to reduce contrast)
    this.fake_cursor = this.add.circle(0, 0, CURSOR_SIZE_RADIUS, LIGHTBLUE).setVisible(false) // animated by program
    this.dbg_cursor = this.add.circle(0, 0, CURSOR_SIZE_RADIUS, RED, 1).setVisible(false && this.is_debug) // "true" cursor pos without clamp/rot, only in debug mode

    // center
    this.add.circle(0, 0, 15, WHITE)
    this.origin = new Phaser.Geom.Circle(0, 0, CENTER_SIZE_RADIUS)

    let radians = Phaser.Math.DegToRad(TARGET_REF_ANGLE)
    let x = TARGET_DISTANCE * Math.cos(radians)
    let y = TARGET_DISTANCE * Math.sin(radians)
    this.target = this.add.circle(x, y, TARGET_SIZE_RADIUS, GRAY)

    this.q1 = this.add.text(0, hd2 / 3, `Which side did the cursor go toward,\n left (${rk['side']['left']}) or right (${rk['side']['right']})?`, {
      fontFamily: 'Verdana',
      fontStyle: 'bold',
      fontSize: 50,
      color: '#ffffff',
      align: 'center',
      stroke: '#444444',
      strokeThickness: 4
    }).
      setOrigin(0.5, 0.5).setVisible(false)

    // big fullscreen quad in front of game, but behind text instructions
    this.darkener = this.add.rectangle(0, 0, height, height, 0x000000).setAlpha(1)

    // noise arc
    this.textures.generate('noise', { data: noise_tex, pixelWidth: 3, pixelHeight: 3 })
    // noise is the thing we draw
    // to "randomize", do a setPosition with two random ints
    // then rotate to some random PI*n/2
    this.noise = this.add.image(0, 0, 'noise').setVisible(false)
    let data = make_thick_arc(
      Math.PI + Math.PI / 3,
      Math.PI * 2 - Math.PI / 3,
      200,
      CENTER_SIZE_RADIUS * 2 + 5,
      TARGET_DISTANCE * 2 - TARGET_SIZE_RADIUS * 2
    )

    let mask = this.add.polygon(0, 0, data, 0xffffff).setVisible(false).setDisplayOrigin(0, 0)
    this.noise.mask = new Phaser.Display.Masks.BitmapMask(this, mask)

    // other warnings
    this.other_warns = this.add.
      rexBBCodeText(0, 0, '', {
        fontFamily: 'Verdana',
        fontStyle: 'bold',
        fontSize: 50,
        color: '#ffffff',
        align: 'center',
        stroke: '#444444',
        backgroundColor: '#000000',
        strokeThickness: 4
      }).
      setOrigin(0.5, 0.5).
      setVisible(false)

    this.instructions = TypingText(this, /* half width */-400, -hd2 + 50, '', {
      fontFamily: 'Verdana',
      fontSize: 22,
      wrap: {
        mode: 'word',
        width: 800
      }
    }).setVisible(false)

    this.start_txt = this.add.
      text(0, hd2 - 100, 'Click the mouse button to continue.', {
        fontFamily: 'Verdana',
        fontSize: 50,
        align: 'center'
      }).
      setOrigin(0.5, 0.5).
      setVisible(false)

    this.debug_txt = this.add.text(-hd2, -hd2, '')
    this.progress = this.add.text(hd2, -hd2, '').setOrigin(1, 0)
    this.tmp_counter = 1
    this.total_len = countTrials(this.trials)
    // examples
    this.examples = {
      // go + feedback
      basic: new BasicExample(this, 0, 200, true, false, rk['side']['right']).setVisible(false),
      mask: new BasicExample(this, 0, 200, true, true, rk['side']['right']).setVisible(false)
    }

    // question responses
    this.resp_queue = []
    this.rt_ref = 0 //
    this.input.keyboard.on(`keydown-${rk['side']['left']}`, (evt) => {
      this.resp_queue.push({side: 'l', rt: evt.timeStamp - this.rt_ref})
    })

    this.input.keyboard.on(`keydown-${rk['side']['right']}`, (evt) => {
      this.resp_queue.push({side: 'r', rt: evt.timeStamp - this.rt_ref})
    })

    // start the mouse at offset
    this.raw_x = CURSOR_RESTORE_POINT
    this.raw_y = CURSOR_RESTORE_POINT
    this.next_trial()

    // set up mouse callback (does all the heavy lifting)
    this.input.on('pointerdown', () => {
      if (this.state !== states.END) {
        this.scale.startFullscreen()
        this.time.delayedCall(300, () => {
          this.input.mouse.requestPointerLock()
        })
      }
    })
    this.input.on('pointerlockchange', () => {
      console.log('oh no, this does not work')
    })

    this.input.on('pointermove', (ptr) => {
      let time = window.performance.now() // the time in the ptr should be a little quicker...
      if (this.input.mouse.locked) {
        // scale movement by const factor
        let dx = ptr.movementX * MOVE_SCALE
        let dy = ptr.movementY * MOVE_SCALE
        // update "raw" mouse position (remember to set these back to (0, 0)
        // when starting a new trial)
        this.raw_x += dx
        this.raw_y += dy
        this.raw_x = clamp(this.raw_x, -hd2, hd2)
        this.raw_y = clamp(this.raw_y, -hd2, hd2)

        // useful for deciding when to turn on/off visual feedback
        let extent = Math.sqrt(Math.pow(this.raw_x, 2) + Math.pow(this.raw_y, 2))
        // convert cursor angle to degrees
        let cursor_angle = Phaser.Math.RadToDeg(Phaser.Math.Angle.Normalize(Math.atan2(this.raw_y, this.raw_x)))
        let curs_x = this.raw_x
        let curs_y = this.raw_y
        this.dbg_cursor.setPosition(curs_x, curs_y)

        this.cursor_angle = cursor_angle
        this.user_cursor.x = curs_x
        this.user_cursor.y = curs_y
        this.extent = extent

        if (this.state === states.MOVING) {
          this.trial_data.push({
            callback_time: time,
            evt_time: ptr.moveTime,
            raw_x: this.raw_x,
            raw_y: this.raw_y,
            cursor_x: curs_x,
            cursor_y: curs_y,
            cursor_extent: extent,
            cursor_angle: cursor_angle
          })
        }
      }
    })
    // initial instructions (move straight through target)
    instruct_txts['instruct_basic'] =
      `You will see one target.\n\nHold your mouse in the circle at the center of the screen to start a trial.\n\nWhen the target turns [color=#00ff00]green[/color], move your mouse straight through it. The target will turn [color=#777777]gray[/color] when you have moved far enough.\n\nAlways try to make [b][color=yellow]straight[/color][/b] mouse movements.\n\nAfter each reach, we will ask you a question:\n\n[size=28]Which side of the target do you think the cursor went toward, left (press the [b][color=yellow]${rk['side']['left']}[/color][/b] key), or right (press the [b][color=yellow]${rk['side']['right']}[/color][/b] key)?[/size]\n\nFor example, see below: the cursor goes to the right of the target, so we press the [b][color=yellow]${rk['side']['right']}[/color][/b] key.`

    instruct_txts['instruct_mask'] =
      'In this section, the cursor will be [color=yellow]hidden[/color] by an image at the beginning and end of the movement. The image will be temporarily removed partway through the movement, and you will be able to see the cursor then.\n\nWe will ask you to answer the same question as before:\n\nWhich side of the target do you think the cursor went toward?\n\nRemember to try to make [color=yellow]straight[/color][/b] mouse movements.'

    instruct_txts['instruct_probe'] =
      'Great job! We\'ll continue these trials until the end.\n\nThe amount of time the cursor is [color=yellow]hidden[/color] may vary over time and you may need to guess sometimes, but always do your best to make [color=yellow]straight mouse movements to the target[/color] and answer the question as best you can.'
  } // end create

  update() {
    switch (this.state) {
    case states.INSTRUCT:
      if (this.entering) {
        this.entering = false
        let tt = this.current_trial.trial_type
        // if we're in probe phase, re-figure out the staircase
        if (tt === 'instruct_probe') {
          let med_mt = median(this.practice_mask_mts) // calculate median movement time across ~ 10 reaches
          // convert to frame space and round up
          let per_ms = 1000 / this.game.user_config.refresh_rate_guess
          let frame_mt = Math.round(med_mt / per_ms)
          // make sure we're > 80 ms or so
          let min_frame = Math.ceil(80 / per_ms)
          console.log(`New max frame: ${frame_mt} (min is ${min_frame})`)
          this.game.user_config['est_mt'] = frame_mt
          frame_mt = Math.max(min_frame, frame_mt)
          this.game.user_config['used_mt'] = frame_mt
          // set up new staircase
          this.staircase = new Staircase(1, frame_mt, 1, 2)
          MAX_STAIRCASE = frame_mt
        }

        // show the right instruction text, wait until typing complete
        // and response made
        this.noise.visible = false
        this.instructions.visible = true
        this.darkener.visible = true
        this.instructions.start(instruct_txts[tt], this.typing_speed)
        if (tt === 'instruct_basic') {
          this.examples.basic.visible = true
          this.examples.basic.play()
        } else if (tt === 'instruct_mask' || tt === 'instruct_probe') {
          this.examples.mask.visible = true
          this.examples.mask.play()
        }
        this.instructions.typing.once('complete', () => {
          this.start_txt.visible = true
          this.input.once('pointerdown', () => {
            this.examples.basic.stop()
            this.examples.basic.visible = false
            this.examples.mask.stop()
            this.examples.mask.visible = false
            this.next_trial()
            this.darkener.visible = false
            this.instructions.visible = false
            this.instructions.text = ''
            this.start_txt.visible = false
          })
        })
      }
      break
    case states.PRETRIAL:
      if (this.entering) {
        this.entering = false
        this.hold_val = randint(500, 1500)
        this.hold_t = this.hold_val
        this.user_cursor.visible = true
        this.t_ref = window.performance.now()
        // draw mask, if needed
        this.noise.visible = this.current_trial.is_masked
        if (this.is_debug) {
          let current_trial = this.current_trial
          let txt = current_trial['trial_type']
          txt += current_trial['trial_label'] ? ', ' + current_trial['trial_label'] + ', ' : ''
          txt += current_trial['pos'] ? current_trial['pos'] : ''
          this.debug_txt.text = txt
        }
      }
      if (Phaser.Geom.Circle.ContainsPoint(this.origin, this.user_cursor)) {
        this.hold_t -= this.game.loop.delta
        if (this.hold_t <= 0) {
          this.inter_trial_interval = window.performance.now() - this.t_ref
          this.raw_x = 0
          this.raw_y = 0
          this.extent = 0
          this.user_cursor.x = 0
          this.user_cursor.y = 0
          this.state = states.MOVING
          this.trial_data = []
        }
      } else {
        this.hold_t = this.hold_val
      }
      break
    case states.MOVING:
      // for non-probe trials, they control the cursor
      // for probe trials, there's a fixed cursor animation
      // that runs completely, regardless of what they do with the cursor
      // only thing they control on probe is initiation time
      let current_trial = this.current_trial
      if (this.entering) {
        this.entering = false
        this.reference_time = this.game.loop.now
        this.last_frame_time = this.game.loop.now
        this.dropped_frame_count = 0
        this.dts = []
        // every trial starts at 0, 0
        this.trial_data.splice(0, 0, {
          callback_time: this.reference_time,
          evt_time: this.reference_time,
          raw_x: 0,
          raw_y: 0,
          cursor_x: 0,
          cursor_y: 0,
          cursor_extent: 0,
          cursor_angle: 0
        })
        this.target.fillColor = GREEN
        if (current_trial.is_masked) {
          this.mask_twn = this.tweens.add({
            targets: this.noise,
            alpha: 1,
            paused: true,
            onStart: () => {
              this.noise.visible = false
              // scramble the mask
              this.noise.setPosition(randint(-20, 20), randint(-20, 20))
              this.noise.rotation = randchoice([0, PI / 2, PI, PI * 3 / 2])
            },
            onComplete: () => {
              this.noise.visible = true
            },
            duration: this.staircase.next(),
            useFrames: true
          })
        }
        if (current_trial.is_clamped) {
          this.user_cursor.visible = false
          // get polar representation of clamp
          let rad = Phaser.Math.DegToRad(current_trial.clamp_angle + TARGET_REF_ANGLE)
          let x = TARGET_DISTANCE * Math.cos(rad)
          let y = TARGET_DISTANCE * Math.sin(rad)
          this.fake_cursor.visible = true
          this.done_curs = false
          this.curs_twn = this.tweens.add({
            targets: this.fake_cursor,
            x: x,
            y: y,
            duration: MAX_STAIRCASE,
            useFrames: true,
            paused: true,
            onUpdate: () => {
              let fake_extent = Math.sqrt(Math.pow(this.fake_cursor.x, 2) + Math.pow(this.fake_cursor.y, 2))
              if (fake_extent >= 0.98 * TARGET_DISTANCE) {
                this.fake_cursor.visible = false
              }
            },
            onComplete: () =>{
              this.fake_cursor.setPosition(0, 0)
            }
          })
          this.curs_twn.once('complete', () => {
            this.done_curs = true
          })
        }
      } else { // second iter ++
        let est_dt = 1 / this.game.user_config.refresh_rate_guess * 1000
        let this_dt = this.game.loop.now - this.last_frame_time
        this.dropped_frame_count += this_dt > 1.5 * est_dt
        this.dts.push(this_dt)
        this.last_frame_time = this.game.loop.now
      }
      let real_extent = Math.sqrt(Math.pow(this.user_cursor.x, 2) + Math.pow(this.user_cursor.y, 2))

      if (current_trial.is_masked && real_extent >= 0.05 * TARGET_DISTANCE) {
        this.mask_twn.play()
        if (current_trial.is_clamped) {
          this.curs_twn.play()
        }
      }
      if (current_trial.is_clamped && this.done_curs || !current_trial.is_clamped && real_extent >= 0.95 * TARGET_DISTANCE) {
        this.target.fillColor = GRAY
        this.user_cursor.visible = false
        if (current_trial.ask_questions) {
          this.state = states.QUESTIONS
        } else { // jumping straight to the posttrial, feed in some junk
          this.resp_queue.splice(0, 0, {side: 'x', rt: 0})
          this.state = states.POSTTRIAL
        }
      }
      break
    case states.QUESTIONS:
      if (this.entering) {
        this.entering = false
        this.rt_ref = this.game.loop.now
        this.resp_queue = [] // empty queue
        this.q1.visible = true
      }
      if (this.resp_queue.length > 0) {
        this.state = states.POSTTRIAL
        this.q1.visible = false
      }
      break
    case states.POSTTRIAL:
      if (this.entering) {
        this.entering = false
        let current_trial = this.current_trial
        let correct = true
        let resp = this.resp_queue[0]
        let cur_stair = this.staircase.next()
        if (current_trial.is_clamped) {
          // we can know which side easily b/c it's clamped
          // only update staircase when clamped
          correct = current_trial.clamp_angle < 0 && resp.side === 'l' ||
                    current_trial.clamp_angle > 0 && resp.side === 'r'
          this.staircase.update(correct)
          // console.log(`frames: ${cur_stair}, correct: ${correct}`)
        }
        // deal with trial data
        let trial_data = {
          movement_data: this.trial_data,
          ref_time: this.reference_time,
          trial_number: this.trial_counter++,
          target_size_radius: TARGET_SIZE_RADIUS, // fixed above
          cursor_size_radius: CURSOR_SIZE_RADIUS,
          iti: this.inter_trial_interval, // amount of time between cursor appear & teleport
          hold_time: this.hold_val,
          which_side: resp,
          n_frames: cur_stair, // get current stair value
          correct: correct,
          dropped_frame_count: this.dropped_frame_count
        }
        let combo_data = merge_data(current_trial, trial_data)
        let delay = 1200
        let fbdelay = 0
        // feedback about movement angle (if non-imagery)
        let first_element = trial_data.movement_data[1]
        let last_element = trial_data.movement_data[trial_data.movement_data.length - 1]
        let target_angle = current_trial.target_angle

        let reach_angles = this.trial_data.filter((a) => a.cursor_extent > 15).map((a) => a.cursor_angle)
        let end_angle = reach_angles.slice(-1)
        let norm_reach_angles = reach_angles.map((a) => signedAngleDeg(a, end_angle))
        let reaction_time = null
        let reach_time = null
        if (last_element && trial_data.movement_data.length > 2) {
          reaction_time = first_element.evt_time - this.reference_time
          reach_time = last_element.evt_time - first_element.evt_time
        }
        if (!(reaction_time === null)) {
          this.rts.push(reaction_time)
          this.movets.push(reach_time)
          if (current_trial.trial_type === 'practice_mask') {
            this.practice_mask_mts.push(reach_time)
          }
        }
        let punished = false
        let punish_delay = 3000
        let punish_flags = 0
        if (Math.abs(signedAngleDeg(last_element.cursor_angle, target_angle)) >= 30) {
          punish_flags |= Err.reached_away
          if (!punished) {
            punished = true
            this.other_warns.text = '[b]Make reaches toward\nthe [color=#00ff00]green[/color] target.[/b]'
          }
        }
        if (reaction_time >= 800) {
          punish_flags |= Err.late_start
          if (!punished) {
            punished = true
            this.other_warns.text = '[b]Please start the\nreach sooner.[/b]'
          }
        }
        if (reach_time >= 400) {
          // slow reach
          punish_flags |= Err.slow_reach
          if (!punished) {
            punished = true
            this.other_warns.text = '[b]Please move quickly\n[color=yellow]through[/color] the target.[/b]'
          }
        }
        if (mad(norm_reach_angles) > 10) {
          // wiggly reach
          punish_flags |= Err.wiggly_reach
          if (!punished) {
            punished = true
            this.other_warns.text = '[b]Please make [color=yellow]straight[/color]\nreaches toward the target.[/b]'
          }
        }
        if (punished) {
          delay += punish_delay
          this.other_warns.visible = true
          this.time.delayedCall(punish_delay, () => {
            this.other_warns.visible = false
          })
        }
        combo_data['delay_time'] = delay
        combo_data['reaction_time'] = reaction_time
        combo_data['reach_time'] = reach_time

        this.time.delayedCall(fbdelay, () => {
          this.time.delayedCall(delay, () => {
            combo_data['any_punishment'] = punished
            combo_data['punish_types'] = punish_flags
            // console.log(combo_data)
            this.all_data[current_trial.trial_type].push(combo_data)
            this.tmp_counter++
            this.raw_x = this.raw_y = this.user_cursor.x = this.user_cursor.y = CURSOR_RESTORE_POINT
            this.user_cursor.visible = true
            this.tweens.add({
              targets: this.user_cursor,
              scale: { from: 0, to: 1 },
              ease: 'Elastic',
              easeParams: [5, 0.5],
              duration: 800,
              onComplete: () => {
                this.next_trial()
              }
            })
          })
        })
      }
      break
    case states.END:
      if (this.entering) {
        this.entering = false
        this.input.mouse.releasePointerLock()
        // fade out
        this.tweens.addCounter({
          from: 255,
          to: 0,
          duration: 2000,
          onUpdate: (t) => {
            let v = Math.floor(t.getValue())
            this.cameras.main.setAlpha(v / 255)
          },
          onComplete: () => {
            // this.scene.start('QuestionScene', { question_number: 1, data: this.all_data })
            this.scene.start('EndScene', this.all_data)
          }
        })
      }
      break
    }
  } // end update

  get state() {
    return this._state
  }

  set state(newState) {
    this.entering = true
    this._state = newState
  }

  next_trial() {
    // move to the next trial, and set the state depending on trial_type
    if (this.tmp_counter > this.total_len) {
      this.progress.visible = false
    } else {
      this.progress.text = `${this.tmp_counter} / ${this.total_len}`
    }
    this.current_trial = this.trials.shift()
    let cur_trial = this.current_trial
    let tt = ''
    if (cur_trial !== undefined) {
      tt = cur_trial.trial_type
    }
    if (cur_trial === undefined || this.trials.length < 1 && tt.startsWith('break')) {
      this.state = states.END
    } else if (tt.startsWith('instruct_') || tt.startsWith('break')) {
      this.state = states.INSTRUCT
    } else if (
      tt.startsWith('practice') ||
      tt.startsWith('probe')
    ) {
      this.state = states.PRETRIAL
    } else {
      // undefine
      console.error('Oh no, wrong next_trial.')
    }
  }
}
