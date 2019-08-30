import Vue from 'vue';
import VueAWN from 'vue-awesome-notifications';
import 'vue-awesome-notifications/dist/styles/style.css';
import VueLoading from 'vue-loading-overlay';
import 'vue-loading-overlay/dist/vue-loading.css'

import App from './App.vue';
import router from './router'
import store from './store'
import './assets/css/tailwind.css';

Vue.config.productionTip = false;
Vue.use(VueAWN, { icons: { enabled: false } });
Vue.use(VueLoading);

new Vue({
  router,
  store,
  render: h => h(App),
}).$mount('#App');
