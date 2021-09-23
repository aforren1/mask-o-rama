Site: https://actlab-mask.netlify.app

https://actlabyale.github.io/web-consent/prolific/?PROLIFIC_PID=5f060d4118d7fd11fd182dee&SESSION_ID=0jiv08k0e&STUDY_ID=614b951cf352bc50a73ee54f&dest=https://actlab-mask.netlify.app&preview=1

Setting up eslint to run on save: https://www.digitalocean.com/community/tutorials/workflow-auto-eslinting

Note that `--servedir` doesn't write the file to disk (see https://esbuild.github.io/api/#serve)

General idea is JS lives in src/, and everything else lives in public/ (so we don't bother copying over during the build step)

Everything lands in devDependencies because this isn't ending up on npm

Staircase:

Their algorithm:

1. Start at 600ms
2. Decrease by large steps in phase 1, smaller steps in phase 2
3. Always increase by large steps when wrong?


We'll probably do:

1. Start at 8 frames (or whatever makes sense)
2. Decrease/increase by 1 frame, with floor at 1 and ceiling at 8 (or whatever matches #1)

 - We should operate in frames, because no sense in doing otherwise
 - And by frames, just count rAF ticks and hope we haven't dropped one (but we get dt, so we can tell)
