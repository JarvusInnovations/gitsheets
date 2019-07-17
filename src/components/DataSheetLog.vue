<template lang="pug">
  .DataSheetLog
    .bg-indigo-100.p-5.-m-5.border-b
      h3 Unsaved changes

      ul.DataSheetLog__stats
        li(v-for="(count, status) in changeCounts" :key="status" :class="'-status-' + status")
          FigureStat(:stat="count" :label="status")

      form(method="post", @submit.prevent="handleCommitPost")
        FieldLabeled.h-20(
          fieldName="message",
          fieldType="textarea",
          placeholderText="What will this commit do to the database?"
          :showLabel="false"
          :value="defaultCommitMessage")
        SubmitButton.mt-3.w-full {{ commitButtonText }}

    h3.mt-8 Commit history

    div
      LogCommit(v-for="commit in sortedCommits"
        :key="commit.id"
        :id="commit.id",
        :date="new Date(commit.date)",
        :author="commit.author",
        :message="commit.message")
</template>

<script>
import commits from '../assets/data/commits.json';

import FigureStat from './FigureStat';
import FieldLabeled from './forms/FieldLabeled';
import LogCommit from './LogCommit';
import SubmitButton from './buttons/SubmitButton';

export default {
  name: 'DataSheetLog',

  components: {
    FigureStat,
    FieldLabeled,
    LogCommit,
    SubmitButton,
  },

  props: {
    records: {
      type: Array,
      required: true,
    },
  },

  data() {
    return {
      commits: commits,
    }
  },

  computed: {
    changeCounts() {
      let groups = this.getChangesGroupedByStatus(),
        counts = {},
        group;

      for (group in groups) {
        counts[group] = groups[group].length;
      }

      return counts;
    },

    commitButtonText() {
      let groups = this.getChangesGroupedByStatus(),
        totalChanges = 0,
        group;

      for (group in groups) {
        totalChanges += groups[group].length;
      }

      return `Commit ${totalChanges} change${totalChanges===1 ? null : 's'}`;
    },

    defaultCommitMessage() {
      let messages = [],
        messageOutput = '';

      const counts = this.changeCounts;

      // build an array of clauses
      if (counts.added) {
        messages.push(`add ${counts.added}`);
      }

      if (counts.updated) {
        messages.push(`update ${counts.updated}`);
      }

      if (counts.removed) {
        messages.push(`remove ${counts.removed}`);
      }

      // build english list
      if (messages.length === 0) {
        messageOutput = '';
      } else if (messages.length === 1) {
        messageOutput = messages[0];
      } else if (messages.length === 2) {
        messageOutput = `${messages[0]} and ${messages[1]}`;
      } else {
        const newMessages = [...messages];
        const lastMessage = newMessages.pop();
        messageOutput = `${newMessages.join(', ')}, and ${lastMessage}`;
      }

      // capitalize and return
      return messageOutput.charAt(0).toUpperCase() + messageOutput.slice(1) + ' students';
    },

    sortedCommits() {
      return commits.sort((a, b) => {
        return new Date(b.date) - new Date(a.date);
      });
    },
  },

  methods: {
    handleCommitPost() {
      alert('Ok')
    },

    getChangesGroupedByStatus() {
      let groups = {};

      this.records.forEach(r => {
        let status = r.status,
          group;

        if (status) {
          group = groups[r.status];

          if (!group) {
            group = groups[r.status] = [];
          }

          group.push(r);
        }
      });

      return groups;
    },
  },
}
</script>

<style scoped lang="postcss">
ul {
  @apply flex justify-between;
}

li {
  @apply flex-1;
}
</style>

<style lang="postcss">
.DataSheetLog {
  @apply border-l overflow-y-scroll px-5 py-3;

  &__stats {
    @apply mb-2;
  }
}

.-status-added {
  @apply text-green-700;
}

.-status-removed {
  @apply text-red-700;
}

.-status-updated {
  @apply text-blue-700;
}
</style>
