import Vue from 'vue'
import Vuex from 'vuex'
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

Vue.use(Vuex)

export default new Vuex.Store({
  state: {
    records: [],
  },
  mutations: {
    SET_RECORDS (state, records) {
      state.records = records;
    },
  },
  actions: {
    async getRecords ({ commit }, gitRef) {
      const response = await api.get(`/${gitRef}/records`);
      commit('SET_RECORDS', response.data);
    },
  },
});
