---
sidebar: false
heroImage: /logo.svg

actionText: Get Started
actionLink: /guide/

altActionText: Learn More
altActionLink: /guide/introduction

features:
  - title: ⚡️ Fast
    details: Peeky is built from the ground up for optimal performance.
  - title: 🔧️ No-config
    details: Sane defaults, with cutomizable configuration.
  - title: 😻️ Fun
    details: The included UI makes running tests fun again!

footer: MIT Licensed | Copyright © 2021-present Guillaume Chau & Peeky Contributors
---

<script setup>
import CustomHome from '/.vitepress/theme/components/Home.vue'
import Features from './Features.vue'
import HomeScreenshot from './HomeScreenshot.vue'
</script>

<CustomHome>
  <template v-slot:hero>
    <HomeScreenshot />
  </template>
  <div class="space-y-12 mb-12">
    <Features/>
  </div>
</CustomHome>