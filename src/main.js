import Vue from 'vue';
import VueAWN from 'vue-awesome-notifications';
import 'vue-awesome-notifications/dist/styles/style.css';

import App from './App.vue';
import router from './router'
import store from './store'
import './assets/css/tailwind.css';

Vue.config.productionTip = false;
Vue.use(VueAWN, { icons: { enabled: false } });

new Vue({
  router,
  store,
  render: h => h(App),
}).$mount('#App');
