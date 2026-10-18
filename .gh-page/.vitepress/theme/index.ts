import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import DefaultTheme from 'vitepress/theme'
import PackageIntroduction from './PackageIntroduction.vue'
import LiveDemo from './LiveDemo.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('PackageIntroduction', PackageIntroduction)
    app.component('LiveDemo', LiveDemo)
  },
}
