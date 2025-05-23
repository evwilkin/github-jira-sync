import { buildJiraIssueData, jiraClient, octokit } from './helpers.js';
import { transitionJiraIssue } from './transitionJiraIssue.js';
import { createSubTasks } from './createJiraIssue.js';

async function findSubTasks(jiraIssueKey) {
  try {
    const response = await jiraClient.get('/rest/api/2/search', {
      params: {
        jql: `parent = ${jiraIssueKey}`,
        fields: 'key,description',
      },
    });
    return response.data.issues;
  } catch (error) {
    console.error('Error finding sub-tasks:', error.message, { error });
    return [];
  }
}

async function updateSubTasks(parentJiraKey, githubIssue) {
  try {
    // Get existing sub-tasks
    const existingSubTasks = await findSubTasks(parentJiraKey);
    const existingSubTaskMap = new Map(
      existingSubTasks
        .map((task) => {
          const match = task.fields.description.match(/Upstream URL/);
          return match ? [match[1], task] : null;
        })
        .filter(Boolean)
    );

    // Get linked issues from GitHub using the timeline API
    const { data: timeline } = await octokit.issues.listEventsForTimeline({
      owner: process.env.GITHUB_OWNER,
      repo: process.env.GITHUB_REPO,
      issue_number: githubIssue.number,
    });

    // Filter for cross-referenced events that indicate sub-issues
    const subIssueEvents = timeline.filter(
      (event) =>
        event.event === 'cross-referenced' &&
        event.source?.issue &&
        event.source.issue.repository_url !== githubIssue.repository_url
    );

    // Update or create sub-tasks
    for (const event of subIssueEvents) {
      const subIssue = event.source.issue;
      const existingTask = existingSubTaskMap.get(subIssue.number.toString());

      if (existingTask) {
        // Update existing sub-task
        const subtask = {
          fields: {
            summary: subIssue.title,
            description: `GH Issue ${subIssue.number}\nGH ID ${
              subIssue.id
            }\nUpstream URL: ${
              subIssue.html_url
            }\nRepo: ${subIssue.repository_url
              .split('/')
              .pop()}\n\nDescription:\n${subIssue.body || ''}`,
          },
        };
        await jiraClient.put(`/rest/api/2/issue/${existingTask.key}`, subtask);
        console.log(
          `Updated sub-task ${existingTask.key} for GitHub issue #${subIssue.number}`
        );
        existingSubTaskMap.delete(subIssue.number.toString());
      } else {
        // Create new sub-task
        await createSubTasks(parentJiraKey, subIssue);
      }
    }

    // Close any remaining sub-tasks that no longer exist in GitHub
    for (const [_, task] of existingSubTaskMap) {
      await transitionJiraIssue(task.key, 'Done');
      console.log(
        `Closed sub-task ${task.key} as it no longer exists in GitHub`
      );
    }
  } catch (error) {
    console.error('Error updating sub-tasks:', error.message, { error });
  }
}

export async function updateJiraIssue(jiraIssue, githubIssue) {
  try {
    const jiraIssueData = buildJiraIssueData(githubIssue);

    await jiraClient.put(`/rest/api/2/issue/${jiraIssue.id}`, jiraIssueData);

    // Add remote link to GitHub issue
    await jiraClient.post(`/rest/api/2/issue/${jiraIssue.key}/remotelink`, {
      globalId: `github-${githubIssue.id}`,
      application: {
        type: 'com.github',
        name: 'GitHub',
      },
      relationship: 'relates to',
      object: {
        url: githubIssue.html_url,
        title: githubIssue.html_url,
      },
    });

    // Check if Jira issue is closed, needs to be reopened
    if (jiraIssue.fields.status.name === 'Closed') {
      console.log(
        ` - GitHub issue #${githubIssue.number} is open but Jira issue ${jiraIssue.key} is closed, transitioning to New`
      );
      await transitionJiraIssue(jiraIssue.key, 'New');
    }

    // Update sub-tasks
    await updateSubTasks(jiraIssue.key, githubIssue);

    console.log(
      `Updated Jira issue ${jiraIssue.key} for GitHub issue #${githubIssue.number}`
    );
  } catch (error) {
    console.error('Error updating Jira issue:', error.message, { error });
  }
}
