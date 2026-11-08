# How Example Widgets Inc. gets a widget to the door

Four steps, two days, and one warehouse that sets the pace for every channel.

## In depth

### From click to doorstep

Every order takes the same path. The warehouse picks, packs and ships every order within two days.

**Four steps from click to doorstep**

1. **Click** A shopper clicks a search ad and lands on the widget page.
2. **Buy** They pay; the order reaches the warehouse within a minute.
3. **Pack** A picker finds the widget and packs it with **recycled** filler.
4. **Ship** A courier collects the parcel the same afternoon.

*Shelves in a distribution warehouse. Tall warehouse shelves*

### Where the days go

Packing is the slowest step. Shipping depends on the courier, not on the warehouse.

*Packing takes the longest: Hours per step, Q3 median*

|  | Hours |
| --- | --- |
| Click to buy | 0.2 |
| Buy to pack | 3 |
| Pack | 9 |
| Ship | 30 |

### How the routing model learns

The model that plans picker routes learns by small corrections. The size of each correction is its learning rate.

*Too small crawls, too big overshoots*

Drag the learning rate. Small steps crawl toward the bottom; big steps overshoot and fly off.

An error curve shaped like a bowl with three paths of a ball: one barely moves, one settles at the bottom, one bounces away.

| Learning rate | Outcome | Steps | Result |
| --- | --- | --- | --- |
| 0.001 | crawls | 60 | x = -3.655 |
| 0.1 | converges | 37 | x = -0.009785 |
| 1.5 | diverges | 12 | flew off |

### Guessing delivery times

To estimate how long deliveries take, the planner walks through likely values at random.

*Step size decides how well the walker explores*

Drag the step size and press Play. Watch where the walker spends its time.

A bell-shaped curve with three strips under it: one narrow, one as wide as the curve, one with a few scattered marks.

| Step size | Outcome | Steps | Result |
| --- | --- | --- | --- |
| 0.05 | sticks | 300 | 100% accepted |
| 1 | mixes | 300 | 71% accepted |
| 20 | stuck | 300 | 7% accepted |

## ELI5

### A big room full of shelves

The widgets wait on tall shelves until someone buys one.

*Boxes ready to go out. Cardboard boxes stacked on a cart*

## ASD-STE100

*ASD-STE100 is Simplified Technical English, a writing standard that began in aerospace maintenance manuals in the late 1970s. Sentences are short (instructions at most 20 words, descriptions at most 25), each sentence gives one instruction, one word keeps one meaning, and verbs are in the active voice.*

### From the click to the door

Each order follows the same path. The warehouse sends each order in two days or less.

**Four steps from the click to the door**

1. **Click** The customer clicks a search advertisement. The widget page opens.
2. **Buy** The customer pays. The order goes to the warehouse in one minute.
3. **Pack** A picker finds the widget. The picker puts it in a box with **recycled** filler.
4. **Ship** A courier collects the box on the same afternoon.

*Shelves in a distribution warehouse. Tall warehouse shelves*

### Where the time goes

Packing is the slowest step. The courier, not the warehouse, sets the shipping time.

*Packing takes the longest: Hours per step, Q3 median*

|  | Hours |
| --- | --- |
| Click to buy | 0.2 |
| Buy to pack | 3 |
| Pack | 9 |
| Ship | 30 |

### How the routing model learns

The routing model makes small corrections. The learning rate sets the size of each correction.

*Too small crawls, too big overshoots*

Drag the learning rate. Small steps crawl toward the bottom; big steps overshoot and fly off.

An error curve shaped like a bowl with three paths of a ball: one barely moves, one settles at the bottom, one bounces away.

| Learning rate | Outcome | Steps | Result |
| --- | --- | --- | --- |
| 0.001 | crawls | 60 | x = -3.655 |
| 0.1 | converges | 37 | x = -0.009785 |
| 1.5 | diverges | 12 | flew off |

### How the planner estimates delivery times

The planner tries likely values at random. It keeps the values that agree with the data.

*Step size decides how well the walker explores*

Drag the step size and press Play. Watch where the walker spends its time.

A bell-shaped curve with three strips under it: one narrow, one as wide as the curve, one with a few scattered marks.

| Step size | Outcome | Steps | Result |
| --- | --- | --- | --- |
| 0.05 | sticks | 300 | 100% accepted |
| 1 | mixes | 300 | 71% accepted |
| 20 | stuck | 300 | 7% accepted |

## ELI5: From click to doorstep

### Why two days

A helper finds your widget, puts it in a box and gives it to a driver.

## Sources

- widget-sales-q3.pptx: PowerPoint, 2.0 MB
- [Example Widgets Inc. pricing](https://www.example.com/widgets/pricing): Fetched page
- Pasted text: 9 words
- [portal.example.com/login](https://portal.example.com/login) (skipped: Page required login.)
- old-forecast.numbers (skipped: File type is not supported.)
