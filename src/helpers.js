import { Octokit } from '@octokit/rest';
import axios from 'axios';

// Initialize Octokit with GraphQL support
export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
  baseUrl: 'https://api.github.com',
});

// Initialize Jira client
export const jiraClient = axios.create({
  baseURL: process.env.JIRA_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.JIRA_PAT}`,
  },
});

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const userMappings = {
  evwilkin: 'ewilkins@redhat.com',
};
// Map GitHub issue type to Jira issue type
const issueTypeMappings = {
  Bug: 'Bug',
  Epic: 'Epic',
  Task: 'Task',
  Feature: 'Story',
  DevX: 'Task',
  Documentation: 'Story',
  Demo: 'Story',
  Support: 'Story',
  'Tech debt': 'Task',
  Initiative: 'Feature',
};

const availableComponents = [
  'AI-infra-ui-components',
  'chatbot',
  'design-tokens',
  'icons',
  'mission-control-dashboard',
  'patternfly',
  'patternfly-a11y',
  'patternfly-design',
  'patternfly-design-kit',
  'patternfly-extension-seed',
  'patternfly-infra-issues',
  'patternfly-org',
  'patternfly-quickstarts',
  'patternfly-react',
  'patternfly-react-seed',
  'pf-codemods',
  'pf-roadmap',
  'react-catalog-view',
  'react-component-groups',
  'react-console',
  'react-data-view',
  'react-log-viewer',
  'react-topology',
  'react-user-feedback',
  'react-virtualized-extension',
  'virtual-assistant',
];

export const getJiraComponent = (repoName) =>
  availableComponents.includes(repoName) ? repoName : null;

export const buildJiraIssueData = (githubIssue, isUpdateIssue = false) => {
  const {
    title,
    url,
    body = '',
    id,
    number,
    labels,
    assignees,
    state,
    issueType,
  } = githubIssue;

  // Extract repository name from the repository object
  const jiraComponent = getJiraComponent(url.split('/')[4]);

  // Map labels from GraphQL structure
  const jiraLabels = labels.nodes.map((label) =>
    label.name.split(' ').join('-')
  );

  // Map assignees from GraphQL structure
  const assigneeLogins = assignees.nodes.map((a) => a.login);
  const jiraAssignee = userMappings[assigneeLogins[0]] || '';
  const jiraIssueType = issueTypeMappings[issueType?.name] || 'Story';

  // build the Jira issue object to create/update Jira with
  // Updating an issue allows fewer fields than creating new issue
  const jiraIssue = isUpdateIssue
    ? {
        fields: {
          summary: title,
          description: `GH Issue ${number}\nGH ID ${id}\nUpstream URL: ${url}\nAssignees: ${assigneeLogins.join(
            ', '
          )}\n\n----\n\n*Description:*\n${body || ''}`,
          labels: ['GitHub', ...jiraLabels],
          assignee: { name: jiraAssignee },
          components: [
            {
              name: jiraComponent,
            },
          ],
        },
      }
    : {
        fields: {
          project: {
            key: process.env.JIRA_PROJECT_KEY,
          },
          summary: title,
          description: `GH Issue ${number}\nGH ID ${id}\nUpstream URL: ${url}\nAssignees: ${assigneeLogins.join(
            ', '
          )}\n\n----\n\n*Description:*\n${body || ''}`,
          issuetype: {
            name: jiraIssueType,
          },
          labels: ['GitHub', ...jiraLabels],
          assignee: { name: jiraAssignee },
          components: [
            {
              name: jiraComponent,
            },
          ],
          [jiraIssueType === 'Epic' ? 'customfield_12311141' : '']: title, // Epic name field is required
        },
      };

  return jiraIssue;
};

// Helper function to execute GraphQL queries
export async function executeGraphQLQuery(query, variables) {
  try {
    const response = await octokit.graphql(query, variables);
    return response;
  } catch (error) {
    console.error('GraphQL query error:', error);
    throw error;
  }
}

// GraphQL queries
export const GET_ALL_REPO_ISSUES = `
  query GetAllRepoIssues(
    $owner: String!
    $repo: String!
    $numIssuesToFetch: Int = 30
    $issuesCursor: String = null
    $issueStates: [IssueState!] = [OPEN]
    $numLabelsPerIssue: Int = 10
    $numAssigneesPerIssue: Int = 10
    $numCommentsPerIssue: Int = 20
    $numSubIssuesPerIssue: Int = 30
    $since: DateTime
  ) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: $numIssuesToFetch
        after: $issuesCursor
        states: $issueStates
        filterBy: {since: $since}
        orderBy: {field: CREATED_AT, direction: DESC}
      ) {
        nodes {
          id
          number
          title
          url
          body
          state
          issueType {
            name
          }
          labels(first: $numLabelsPerIssue) {
            nodes {
              name
            }
            totalCount
          }
          assignees(first: $numAssigneesPerIssue) {
            nodes {
              login
            }
            totalCount
          }
          comments(first: $numCommentsPerIssue, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes {
              author {
                login
              }
              body
              createdAt
              updatedAt
              url
            }
            totalCount
          }
          subIssues(first: $numSubIssuesPerIssue) {
            nodes {
              title
              url
              state
              number
              repository {
                nameWithOwner
              }
              assignees(first: 3) {
                nodes {
                  login
                }
              }
              labels(first: 3) {
                nodes {
                  name
                }
              }
            }
            totalCount
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
        totalCount
      }
    }
  }
`;

export const GET_ISSUE_DETAILS = `
  query GetIssueDetails(
    $owner: String!
    $repo: String!
    $issueNumber: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        id
        number
        title
        url
        bodyText
        state
        issueType {
          name
        }
        labels(first: 10) {
          nodes {
            name
          }
          totalCount
        }
        assignees(first: 10) {
          nodes {
            login
          }
          totalCount
        }
        comments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            author {
              login
            }
            bodyText
            createdAt
            updatedAt
          }
          totalCount
        }
        subIssues(first: 50) {
          nodes {
            state
            title
            url
            number
            repository {
              nameWithOwner
            }
            assignees(first: 3) {
              nodes {
                login
              }
            }
            labels(first: 10) {
              nodes {
                name
              }
            }
          }
          totalCount
        }
      }
    }
  }
`;

export const repoIssues = executeGraphQLQuery(GET_ALL_REPO_ISSUES, {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
});
