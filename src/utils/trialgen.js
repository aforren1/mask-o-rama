/*
NB target distance is a constant in main
center & target sizes are consts in main
{
    ask_questions: bool,
    is_clamped: bool,
    clamp_angle: float,
    trial_type: str,
    is_masked: bool, // mask duration is staircased
}
*/

/*
repeats (default 40?) is number of repeats per clamp type (left vs right)
*/

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
}

export default function generateTrials(repeats, CLAMP_ANGLE = 15, is_debug = false, n_catch_per_10_clamp = 4) {
  let probe_trial_types = [
    { trial_type: 'probe', ask_questions: true, is_masked: true, is_clamped: true, clamp_angle: CLAMP_ANGLE },
    { trial_type: 'probe', ask_questions: true, is_masked: true, is_clamped: true, clamp_angle: -CLAMP_ANGLE }
  ]

  let catch_trial_types = [
    { trial_type: 'catch', ask_questions: true, is_masked: true, is_clamped: false, clamp_angle: 0}
  ]

  let reps = is_debug ? 1 : 5
  let out = []
  out.push({ trial_type: 'instruct_basic' }) // reach + q
  for (let i = 0; i < reps; i++) {
    out.push({
      trial_type: 'practice_basic',
      ask_questions: true,
      is_masked: false,
      is_clamped: false,
      clamp_angle: 0
    })
  }

  out.push({ trial_type: 'instruct_mask' })
  for (let i = 0; i < reps * 2; i++) {
    out.push({
      trial_type: 'practice_mask',
      ask_questions: true,
      is_masked: true,
      is_clamped: false,
      clamp_angle: 0
    })
  }

  out.push({ trial_type: 'instruct_probe' })
  // do groups of 10 trials at a time. 5 each trial type
  // append catch trials
  let n_trials = repeats * probe_trial_types.length
  if (n_trials % 10 !== 0) {
    console.error('Make sure repeats leads to something divisible by 10.')
    console.error(`Repeats was ${repeats}, n_trials was ${n_trials}`)
  }
  // generate 10 trials to use as prototype
  let proto = Array(5).fill(probe_trial_types).flat()
  // append catch trials (no cursor visible)
  proto.push(...Array(n_catch_per_10_clamp).fill(catch_trial_types).flat())
  for (let i = 0; i < n_trials / 10; i++) {
    // we used to have fancy
    shuffleArray(proto)
    // add to out
    for (let j = 0; j < proto.length; j++) {
      out.push(proto[j])
    }
  }
  console.log(out)
  return out
}
